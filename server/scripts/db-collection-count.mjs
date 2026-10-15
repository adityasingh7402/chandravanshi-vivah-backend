'use strict';

/** One-off diagnostic: collections per database (Atlas cluster cap is 500). */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

await mongoose.connect(process.env.MONGODB_URI, { dbName: 'admin' });
const admin = mongoose.connection.db.admin();
const dbs = await admin.listDatabases({ nameOnly: true });
let total = 0;
const rows = [];
for (const d of dbs.databases) {
  if (['admin', 'local', 'config'].includes(d.name)) continue;
  const n = await mongoose.connection.client
    .db(d.name)
    .listCollections({}, { nameOnly: true })
    .toArray()
    .then((rows) => rows.length)
    .catch(() => -1);
  total += n;
  rows.push(`${d.name}:${n}`);
}
console.log(`TOTAL ${total}`);
console.log(rows.join('\n'));
await mongoose.disconnect();
