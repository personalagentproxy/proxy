import {sqlConnectRoutes} from '../sql/route';

/** Connecting a MySQL or MariaDB database: Test connection, and Connect. */
export const {handleTest: handleTestMysqlRoute, handleConnect: handleConnectMysqlRoute} = sqlConnectRoutes('mysql');
