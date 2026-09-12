import postgres from "postgres";
const sql = postgres("postgres://directory:directory@localhost:5433/directory_test", { max: 1 });
const t = await sql`select table_name from information_schema.tables where table_schema='public' order by 1`;
console.log(t.map(r=>r.table_name).join(", "));
const c = await sql`select column_name from information_schema.columns where table_name='reviews' order by 1`;
console.log("reviews cols:", c.map(r=>r.column_name).join(", "));
await sql.end();
