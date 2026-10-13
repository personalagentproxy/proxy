import {sqlConnectRoutes} from '../sql/route';

/** Connecting a PostgreSQL database: Test connection, and Connect. */
export const {handleTest: handleTestPostgresRoute, handleConnect: handleConnectPostgresRoute} = sqlConnectRoutes('postgres');
