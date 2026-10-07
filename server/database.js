import { Pool } from 'pg';

const pool = new Pool({
    host: process.env.POSTGRES_HOSTNAME,
    port: process.env.POSTGRES_PORT ?? 5432,
    user: process.env.POSTGRES_USERNAME,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DBNAME,
});

export async function queryMany(query, values = undefined) {
    const client = await pool.connect();
    try {
        const result = await client.query(query, values);
        return result.rows;
    } finally {
        client.release();
    }
}

export async function queryOne(query, values = undefined) {
    const rows = await queryMany(query, values);
    return rows.length > 0 ? rows[0] : null;
}

export async function withTransaction(work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export function endPool() {
    return pool.end();
}
