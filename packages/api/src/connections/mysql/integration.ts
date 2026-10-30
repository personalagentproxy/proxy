import {sqlConnectors} from '../../records/sql-connector';
import {formConnect} from '../form-connect';
import type {ApiIntegration} from '../integration';
import {sqlForm} from '../sql/form';

/** A MySQL or MariaDB database, connected on its form with a database user's name and password. */
export const MYSQL_INTEGRATION: ApiIntegration = {
	id: 'mysql',
	connectors: sqlConnectors('mysql'),
	connect: formConnect('mysql', sqlForm('mysql', 'MySQL')),
};
