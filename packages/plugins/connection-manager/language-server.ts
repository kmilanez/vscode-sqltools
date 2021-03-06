import Connection from '@sqltools/language-server/connection';
import ConfigRO from '@sqltools/util/config-manager';
import { IConnection, NSDatabase, ILanguageServerPlugin, ILanguageServer, RequestHandler } from '@sqltools/types';
import { getConnectionId, migrateConnectionSetting } from '@sqltools/util/connection';
import csvStringify from 'csv-stringify/lib/sync';
import { writeFile as writeFileWithCb } from 'fs';
import { promisify } from 'util';
import { ConnectRequest, DisconnectRequest, SearchConnectionItemsRequest, GetConnectionPasswordRequest, GetConnectionsRequest, RunCommandRequest, SaveResultsRequest, ProgressNotificationStart, ProgressNotificationComplete, TestConnectionRequest, GetChildrenForTreeItemRequest } from './contracts';
import Handlers from './cache/handlers';
import DependencyManager from './dependency-manager/language-server';
import { DependeciesAreBeingInstalledNotification } from './dependency-manager/contracts';
import decorateLSException from '@sqltools/util/decorators/ls-decorate-exception';
import logger from '@sqltools/util/log';
import telemetry from '@sqltools/util/telemetry';
import connectionStateCache, { ACTIVE_CONNECTIONS_KEY, LAST_USED_ID_KEY } from './cache/connections-state.model';
import queryResultsCache from './cache/query-results.model';

const writeFile = promisify(writeFileWithCb);

const log = logger.extend('conn-mann');

export default class ConnectionManagerPlugin implements ILanguageServerPlugin {
  private server: ILanguageServer;
  private getConnectionsList = async () => {
    const [ activeConnections = {}, lastUsedId ] = await Promise.all([
      connectionStateCache.get(ACTIVE_CONNECTIONS_KEY,),
      connectionStateCache.get(LAST_USED_ID_KEY),
    ]);
    return (ConfigRO.connections || []).map(conn => {
      conn = migrateConnectionSetting(conn);
      conn.isActive = getConnectionId(conn) === lastUsedId;
      conn.isConnected = !!activeConnections[getConnectionId(conn)];

      return conn;
    });
  }

  private async getConnectionInstance(creds: IConnection) {
    const id = getConnectionId(creds);
    const activeConnections = await connectionStateCache.get(ACTIVE_CONNECTIONS_KEY, {});
    return <Connection | null>(activeConnections[id] || null);
  }

  private runCommandHandler: RequestHandler<typeof RunCommandRequest> = async ({ conn, args, command }) => {
    try {
      const c = await this.getConnectionInstance(conn);
      if (!c) throw 'Connection not found';
      const results: NSDatabase.IResult[] = await c[command](...args);
      await Handlers.QuerySuccess(results);
      return results;
    } catch (e) {
      this.server.notifyError('Execute query error', e);
      throw e;
    }
  };

  private saveResultsHandler: RequestHandler<typeof SaveResultsRequest> = async ({ fileType, filename, ...opts}) => {
    const { results, cols } = await queryResultsCache.get(queryResultsCache.buildKey(opts));
    if (fileType === 'json') {
      return writeFile(filename, JSON.stringify(results, null, 2));
    }
    if (fileType === 'csv') {
      return writeFile(
        filename,
        csvStringify(results, {
          columns: cols,
          header: true,
          quoted_string: true,
          quoted_empty: true,
        }),
      );
    }
  };

  private searchItemsHandler: RequestHandler<typeof SearchConnectionItemsRequest> = async ({ conn, itemType, search, extraParams = {} }) => {
    if (!conn) {
      return undefined;
    }
    const activeConnections = await connectionStateCache.get(ACTIVE_CONNECTIONS_KEY, {});
    if (Object.keys(activeConnections).length === 0) return { results: [] };

    const c = await this.getConnectionInstance(conn);
    const results = await c.searchItems(itemType, search, extraParams);
    return { results };
  };

  private closeConnectionHandler: RequestHandler<typeof DisconnectRequest> = async ({ conn }) => {
    if (!conn) {
      return undefined;
    }
    const c = await this.getConnectionInstance(conn);
    if (!c) return;
    await c.close().catch(this.server.notifyError('Connection Error'));
    await Handlers.Disconnect(c);
  };

  private GetConnectionPasswordRequestHandler: RequestHandler<typeof GetConnectionPasswordRequest> = async ({ conn }): Promise<string> => {
    if (!conn) {
      return undefined;
    }
    const c = await this.getConnectionInstance(conn);
    if (c) {
      return c.getPassword();
    }
    return null;
  };

  private serializarConnectionState = async (conn: IConnection) => {
    const instance = await this.getConnectionInstance(conn);
    const lastUsedId = await connectionStateCache.get(LAST_USED_ID_KEY);
    if (instance) {
      return {
        ...instance.serialize(),
        isActive: instance.getId() === lastUsedId,
      };
    }
    return conn;
  }

  private openConnectionHandler: RequestHandler<typeof ConnectRequest> = async (req: {
    conn: IConnection;
    password?: string;
  }): Promise<IConnection> => {
    if (!req || !req.conn) {
      return undefined;
    }
    let c = await this.getConnectionInstance(req.conn);
    let progressBase;
    try {
      if (c) {
        await Handlers.Connect(c);
        return this.serializarConnectionState(req.conn);
      }
      c = new Connection(req.conn, () => this.server.server.workspace.getWorkspaceFolders());

      // @OPTIMIZE
      progressBase = {
        id: `progress:${c.getId()}`,
        title: c.getName(),
      }

      if (req.password) c.setPassword(req.password);

      await Handlers.Connect(c);

      this.server.sendNotification(ProgressNotificationStart, { ...progressBase, message: 'Connecting....' });
      await c.connect();
      this.server.sendNotification(ProgressNotificationComplete, { ...progressBase, message: 'Connected!' });
      return this.serializarConnectionState(req.conn);
    } catch (e) {
      log.extend('Connecting error: %O', e);
      await Handlers.Disconnect(c);
      progressBase && this.server.sendNotification(ProgressNotificationComplete, progressBase);
      e = decorateLSException(e, { conn: req.conn });
      if (e.data && e.data.notification) {
        if (req.conn.driver && DependencyManager.runningJobs.includes(req.conn.driver)) {
          return void this.server.sendNotification(DependeciesAreBeingInstalledNotification, e.data.args);
        }
        return void this.server.sendNotification(e.data.notification, e.data.args);
      }

      telemetry.registerException(e);

      throw e;
    }
  };

  private testConnectionHandler: RequestHandler<typeof TestConnectionRequest> = async (req: {
    conn: IConnection;
    password?: string;
  }): Promise<IConnection> => {
    if (!req || !req.conn) {
      return undefined;
    }
    const progressBase = {
      id: `progress:testingConnection`,
      title: req.conn.name,
    }
    try {
      this.server.sendNotification(ProgressNotificationStart, { ...progressBase, message: 'Testing connection....' });
      const creds = {
        ...req.conn,
        password: req.conn.password || req.password,
      }
      await Connection.testConnection(creds, () => this.server.server.workspace.getWorkspaceFolders());
      this.server.sendNotification(ProgressNotificationComplete, { ...progressBase, message: 'Connection test successful!' });
      return req.conn;
    } catch (e) {
      progressBase && this.server.sendNotification(ProgressNotificationComplete, progressBase);
      e = decorateLSException(e, { conn: req.conn });
      if (e.data && e.data.notification) {
        if (req.conn.driver && DependencyManager.runningJobs.includes(req.conn.driver)) {
          return void this.server.sendNotification(DependeciesAreBeingInstalledNotification, e.data.args);
        }
        delete e.data.args.conn;
        this.server.sendNotification(e.data.notification, e.data.args);
        return e.data;
      }
      throw e;
    }
  };

  private clientRequestConnectionHandler: RequestHandler<typeof GetConnectionsRequest> = async ({ connId, connectedOnly, sort = 'connectedFirst' } = {}) => {
    let connList = await this.getConnectionsList();

    if (connId) return connList.filter(c => c.id === connId);

    if (connectedOnly) connList = connList.filter(c => c.isConnected);

    switch (sort) {
      case 'name':
      return connList
        .sort((a, b) => a.name.localeCompare(b.name));
      case 'connectedFirst':
      default:
        return connList
        .sort((a, b) => {
          if (a.isConnected === b.isConnected) return a.name.localeCompare(b.name);
          if (a.isConnected && !b.isConnected) return -1;
          if (!a.isConnected && b.isConnected) return 1;
        });

    }
  }

  private GetChildrenForTreeItemHandler: RequestHandler<typeof GetChildrenForTreeItemRequest> = async (req) => {
    if (!req || !req.conn) {
      return [];
    }
    const { conn, ...params } = req;
    let c = await this.getConnectionInstance(conn);
    if (!c) return [];
    return c.getChildrenForItem(params);
  };

  public register(server: typeof ConnectionManagerPlugin.prototype['server']) {
    server.registerPlugin(new DependencyManager);
    this.server = this.server || server;

    this.server.onRequest(RunCommandRequest, this.runCommandHandler);
    this.server.onRequest(SaveResultsRequest, this.saveResultsHandler);
    this.server.onRequest(SearchConnectionItemsRequest, this.searchItemsHandler);
    this.server.onRequest(DisconnectRequest, this.closeConnectionHandler);
    this.server.onRequest(GetConnectionPasswordRequest, this.GetConnectionPasswordRequestHandler);
    this.server.onRequest(ConnectRequest, this.openConnectionHandler);
    this.server.onRequest(TestConnectionRequest, this.testConnectionHandler);
    this.server.onRequest(GetConnectionsRequest, this.clientRequestConnectionHandler);
    this.server.onRequest(GetChildrenForTreeItemRequest, this.GetChildrenForTreeItemHandler);
    this.server.addOnDidChangeConfigurationHooks(this._autoConnectIfActive);
  }

  // internal utils
  public _autoConnectIfActive = async () => {
    const defaultConnections: IConnection[] = [];
    const [ activeConnections, lastUsedId ] = await Promise.all([
      connectionStateCache.get(ACTIVE_CONNECTIONS_KEY, {}),
      connectionStateCache.get(LAST_USED_ID_KEY),
    ])
    if (lastUsedId && activeConnections[lastUsedId]) {
      defaultConnections.push(await this.serializarConnectionState(activeConnections[lastUsedId].serialize()));
    }
    if (defaultConnections.length === 0
      && (
        typeof ConfigRO.autoConnectTo === 'string'
        || (
          Array.isArray(ConfigRO.autoConnectTo) && ConfigRO.autoConnectTo.length > 0
          )
        )
    ) {
      const autoConnectTo = Array.isArray(ConfigRO.autoConnectTo)
      ? ConfigRO.autoConnectTo
      : [ConfigRO.autoConnectTo];
      log.extend('info')(`Configuration set to auto connect to: ${autoConnectTo}`);

      defaultConnections.push(...ConfigRO.connections
        .filter((conn) => conn && autoConnectTo.indexOf(conn.name) >= 0)
        .filter(Boolean));
    }
    if (defaultConnections.length === 0) {
      return;
    }
    try {
      await Promise.all(defaultConnections.slice(1).map(conn =>
        (<Promise<IConnection>>this.openConnectionHandler({ conn }))
          .catch(e => {
            this.server.notifyError(`Failed to auto connect to  ${conn.name}`, e);
            return Promise.resolve();
          }),
      ));

      await this.openConnectionHandler({ conn: defaultConnections[0] });
    } catch (error) {
      if (error.data && error.data.notification) {
        return void this.server.sendNotification(error.data.notification, error.data.args);
      }
      this.server.notifyError('Auto connect failed', error);
    }
  }
}
