import { MongoClient } from 'mongodb';

export async function connect(uri, dbName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db(dbName);
  await Promise.all([
    // state из OIDC-входа живёт 10 минут и используется один раз
    db.collection('states').createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 }),
    // сессии удаляются автоматически по expiresAt
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('sessions').createIndex({ sid: 1 }, { unique: true }),
    // один requestId = одна попытка (защита от двойной отправки)
    db.collection('attempts').createIndex({ userKey: 1, requestId: 1 }, { unique: true }),
    db.collection('attempts').createIndex({ userKey: 1, createdAt: -1 }),
  ]);
  return { client, db };
}
