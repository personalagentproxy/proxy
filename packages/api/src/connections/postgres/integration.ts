import {sqlConnectors} from '../../records/sql-connector';
import {formConnect} from '../form-connect';
import type {ApiIntegration} from '../integration';
import {sqlForm} from '../sql/form';

/** A PostgreSQL database, connected on its form with a database user's name and password. */
export const POSTGRES_INTEGRATION: ApiIntegration = {
	id: 'postgres',
	connectors: sqlConnectors('postgres'),
	connect: formConnect('postgres', sqlForm('postgres', 'Postgres')),
};
