// Flags: --experimental-sqlite
'use strict';
const { spawnPromisified } = require('../common');
const tmpdir = require('../common/tmpdir');
const { join } = require('node:path');
const {
  DatabaseSync,
  SQLITE_CHANGESET_OMIT,
  SQLITE_CHANGESET_REPLACE,
  SQLITE_CHANGESET_ABORT
} = require('node:sqlite');
const { suite, test } = require('node:test');
let cnt = 0;

tmpdir.refresh();

function nextDb() {
  return join(tmpdir.path, `database-${cnt++}.db`);
}

suite('accessing the node:sqlite module', () => {
  test('cannot be accessed without the node: scheme', (t) => {
    t.assert.throws(() => {
      require('sqlite');
    }, {
      code: 'MODULE_NOT_FOUND',
      message: /Cannot find module 'sqlite'/,
    });
  });

  test('cannot be accessed without --experimental-sqlite flag', async (t) => {
    const {
      stdout,
      stderr,
      code,
      signal,
    } = await spawnPromisified(process.execPath, [
      '-e',
      'require("node:sqlite")',
    ]);

    t.assert.strictEqual(stdout, '');
    t.assert.match(stderr, /No such built-in module: node:sqlite/);
    t.assert.notStrictEqual(code, 0);
    t.assert.strictEqual(signal, null);
  });
});

test('ERR_SQLITE_ERROR is thrown for errors originating from SQLite', (t) => {
  const db = new DatabaseSync(nextDb());
  t.after(() => { db.close(); });
  const setup = db.exec(`
    CREATE TABLE test(
      key INTEGER PRIMARY KEY
    ) STRICT;
  `);
  t.assert.strictEqual(setup, undefined);
  const stmt = db.prepare('INSERT INTO test (key) VALUES (?)');
  t.assert.deepStrictEqual(stmt.run(1), { changes: 1, lastInsertRowid: 1 });
  t.assert.throws(() => {
    stmt.run(1);
  }, {
    code: 'ERR_SQLITE_ERROR',
    message: 'UNIQUE constraint failed: test.key',
    errcode: 1555,
    errstr: 'constraint failed',
  });
});

test('in-memory databases are supported', (t) => {
  const db1 = new DatabaseSync(':memory:');
  const db2 = new DatabaseSync(':memory:');
  const setup1 = db1.exec(`
    CREATE TABLE data(key INTEGER PRIMARY KEY);
    INSERT INTO data (key) VALUES (1);
  `);
  const setup2 = db2.exec(`
    CREATE TABLE data(key INTEGER PRIMARY KEY);
    INSERT INTO data (key) VALUES (1);
  `);
  t.assert.strictEqual(setup1, undefined);
  t.assert.strictEqual(setup2, undefined);
  t.assert.deepStrictEqual(
    db1.prepare('SELECT * FROM data').all(),
    [{ key: 1 }]
  );
  t.assert.deepStrictEqual(
    db2.prepare('SELECT * FROM data').all(),
    [{ key: 1 }]
  );
});

test('PRAGMAs are supported', (t) => {
  const db = new DatabaseSync(nextDb());
  t.after(() => { db.close(); });
  t.assert.deepStrictEqual(
    db.prepare('PRAGMA journal_mode = WAL').get(),
    { journal_mode: 'wal' },
  );
  t.assert.deepStrictEqual(
    db.prepare('PRAGMA journal_mode').get(),
    { journal_mode: 'wal' },
  );
});

suite('session extension', () => {
  test('creating and applying a changeset', (t) => {
    const createDataTableSql = `
      CREATE TABLE data(
        key INTEGER PRIMARY KEY,
        value TEXT
      ) STRICT`;

    const createDatabase = () => {
      const database = new DatabaseSync(':memory:');
      database.exec(createDataTableSql);
      return database;
    };

    const databaseFrom = createDatabase();
    const session = databaseFrom.createSession();

    const select = 'SELECT * FROM data ORDER BY key';

    const insert = databaseFrom.prepare('INSERT INTO data (key, value) VALUES (?, ?)');
    insert.run(1, 'hello');
    insert.run(2, 'world');

    const databaseTo = createDatabase();

    t.assert.strictEqual(databaseTo.applyChangeset(session.changeset()), true);
    t.assert.deepStrictEqual(
      databaseFrom.prepare(select).all(),
      databaseTo.prepare(select).all()
    );
  });

  test('database.createSession() - closed database results in exception', (t) => {
    const database = new DatabaseSync(':memory:');
    database.close();
    t.assert.throws(() => {
      database.createSession();
    }, {
      name: 'Error',
      message: 'database is not open',
    });
  });

  test('session.changeset() - closed database results in exception', (t) => {
    const database = new DatabaseSync(':memory:');
    const session = database.createSession();
    database.close();
    t.assert.throws(() => {
      session.changeset();
    }, {
      name: 'Error',
      message: 'database is not open',
    });
  });

  test('database.applyChangeset() - closed database results in exception', (t) => {
    const database = new DatabaseSync(':memory:');
    const session = database.createSession();
    const changeset = session.changeset();
    database.close();
    t.assert.throws(() => {
      database.applyChangeset(changeset);
    }, {
      name: 'Error',
      message: 'database is not open',
    });
  });

  test('database1.createSession() - use table option to track specific table', (t) => {
    const database1 = new DatabaseSync(':memory:');
    const database2 = new DatabaseSync(':memory:');

    const createData1TableSql = `CREATE TABLE data1 (
      key INTEGER PRIMARY KEY,
      value TEXT
    ) STRICT
    `;
    const createData2TableSql = `CREATE TABLE data2 (
      key INTEGER PRIMARY KEY,
      value TEXT
    ) STRICT
    `;
    database1.exec(createData1TableSql);
    database1.exec(createData2TableSql);
    database2.exec(createData1TableSql);
    database2.exec(createData2TableSql);

    const session = database1.createSession({
      table: 'data1'
    });
    const insert1 = database1.prepare('INSERT INTO data1 (key, value) VALUES (?, ?)');
    insert1.run(1, 'hello');
    insert1.run(2, 'world');
    const insert2 = database1.prepare('INSERT INTO data2 (key, value) VALUES (?, ?)');
    insert2.run(1, 'hello');
    insert2.run(2, 'world');
    const select1 = 'SELECT * FROM data1 ORDER BY key';
    const select2 = 'SELECT * FROM data2 ORDER BY key';
    t.assert.strictEqual(database2.applyChangeset(session.changeset()), true);
    t.assert.deepStrictEqual(
      database1.prepare(select1).all(),
      database2.prepare(select1).all());  // data1 table should be equal
    t.assert.deepStrictEqual(database2.prepare(select2).all(), []);  // data2 should be empty in database2
    t.assert.strictEqual(database1.prepare(select2).all().length, 2);  // data1 should have values in database1
  });

  const prepareConflict = () => {
    const database1 = new DatabaseSync(':memory:');
    const database2 = new DatabaseSync(':memory:');

    const createDataTableSql = `CREATE TABLE data (
      key INTEGER PRIMARY KEY,
      value TEXT
    ) STRICT
    `;
    database1.exec(createDataTableSql);
    database2.exec(createDataTableSql);

    const insertSql = 'INSERT INTO data (key, value) VALUES (?, ?)';
    const session = database1.createSession();
    database1.prepare(insertSql).run(1, 'hello');
    database1.prepare(insertSql).run(2, 'foo');
    database2.prepare(insertSql).run(1, 'world');
    return {
      database2,
      changeset: session.changeset()
    };
  };

  test('database.applyChangeset() - conflict with default behavior (abort)', (t) => {
    const { database2, changeset } = prepareConflict();
    // When changeset is aborted due to a conflict, applyChangeset should return false
    t.assert.strictEqual(database2.applyChangeset(changeset), false);
    t.assert.deepStrictEqual(
      database2.prepare('SELECT value from data').all(),
      [{ value: 'world' }]);  // unchanged
  });

  test('database.applyChangeset() - conflict with SQLITE_CHANGESET_ABORT', (t) => {
    const { database2, changeset } = prepareConflict();
    const result = database2.applyChangeset(changeset, {
      onConflict: SQLITE_CHANGESET_ABORT
    });
    // When changeset is aborted due to a conflict, applyChangeset should return false
    t.assert.strictEqual(result, false);
    t.assert.deepStrictEqual(
      database2.prepare('SELECT value from data').all(),
      [{ value: 'world' }]);  // unchanged
  });

  test('database.applyChangeset() - conflict with SQLITE_CHANGESET_REPLACE', (t) => {
    const { database2, changeset } = prepareConflict();
    const result = database2.applyChangeset(changeset, {
      onConflict: SQLITE_CHANGESET_REPLACE
    });
    // Not aborted due to conflict, so should return true
    t.assert.strictEqual(result, true);
    t.assert.deepStrictEqual(
      database2.prepare('SELECT value from data ORDER BY key').all(),
      [{ value: 'hello' }, { value: 'foo' }]);  // replaced
  });

  test('database.applyChangeset() - conflict with SQLITE_CHANGESET_OMIT', (t) => {
    const { database2, changeset } = prepareConflict();
    const result = database2.applyChangeset(changeset, {
      onConflict: SQLITE_CHANGESET_OMIT
    });
    // Not aborted due to conflict, so should return true
    t.assert.strictEqual(result, true);
    t.assert.deepStrictEqual(
      database2.prepare('SELECT value from data ORDER BY key ASC').all(),
      [{ value: 'world' }, { value: 'foo' }]);  // Conflicting change omitted
  });

  test('session related constants are defined', (t) => {
    t.assert.strictEqual(SQLITE_CHANGESET_OMIT, 0);
    t.assert.strictEqual(SQLITE_CHANGESET_REPLACE, 1);
    t.assert.strictEqual(SQLITE_CHANGESET_ABORT, 2);
  });

  test('database.createSession() - filter changes', (t) => {
    const database1 = new DatabaseSync(':memory:');
    const database2 = new DatabaseSync(':memory:');
    const createTableSql = 'CREATE TABLE data1(key INTEGER PRIMARY KEY); CREATE TABLE data2(key INTEGER PRIMARY KEY);';
    database1.exec(createTableSql);
    database2.exec(createTableSql);

    const session = database1.createSession();

    database1.exec('INSERT INTO data1 (key) VALUES (1), (2), (3)');
    database1.exec('INSERT INTO data2 (key) VALUES (1), (2), (3), (4), (5)');

    database2.applyChangeset(session.changeset(), {
      filter: (tableName) => tableName === 'data2'
    });

    const data1Rows = database2.prepare('SELECT * FROM data1').all();
    const data2Rows = database2.prepare('SELECT * FROM data2').all();

    // Expect no rows since all changes were filtered out
    t.assert.strictEqual(data1Rows.length, 0);
    // Expect 5 rows since these changes were not filtered out
    t.assert.strictEqual(data2Rows.length, 5);
  });

  test('database.createSession() - specify other database', (t) => {
    const database = new DatabaseSync(':memory:');
    const session = database.createSession();
    const sessionMain = database.createSession({
      db: 'main'
    });
    const sessionTest = database.createSession({
      db: 'test'
    });
    database.exec('CREATE TABLE data (key INTEGER PRIMARY KEY)');
    database.exec('INSERT INTO data (key) VALUES (1)');
    t.assert.notStrictEqual(session.changeset().length, 0);
    t.assert.notStrictEqual(sessionMain.changeset().length, 0);
    // Since this session is attached to a different database, its changeset should be empty
    t.assert.strictEqual(sessionTest.changeset().length, 0);
  });

  test('database.createSession() - wrong arguments', (t) => {
    const database = new DatabaseSync(':memory:');
    t.assert.throws(() => {
      database.createSession(null);
    }, {
      name: 'TypeError',
      message: 'The "options" argument must be an object.'
    });

    t.assert.throws(() => {
      database.createSession({
        table: 123
      });
    }, {
      name: 'TypeError',
      message: 'The "options.table" argument must be a string.'
    });

    t.assert.throws(() => {
      database.createSession({
        db: 123
      });
    }, {
      name: 'TypeError',
      message: 'The "options.db" argument must be a string.'
    });
  });

  test('database.applyChangeset() - wrong arguments', (t) => {
    const database = new DatabaseSync(':memory:');
    const session = database.createSession();
    t.assert.throws(() => {
      database.applyChangeset(null);
    }, {
      name: 'TypeError',
      message: 'The "changeset" argument must be a Uint8Array.'
    });

    t.assert.throws(() => {
      database.applyChangeset(session.changeset(), null);
    }, {
      name: 'TypeError',
      message: 'The "options" argument must be an object.'
    });

    t.assert.throws(() => {
      database.applyChangeset(session.changeset(), {
        filter: null
      }, null);
    }, {
      name: 'TypeError',
      message: 'The "options.filter" argument must be a function.'
    });

    t.assert.throws(() => {
      database.applyChangeset(session.changeset(), {
        onConflict: null
      }, null);
    }, {
      name: 'TypeError',
      message: 'The "options.onConflict" argument must be a number.'
    });
  });

  test('session.patchset()', (t) => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE data(key INTEGER PRIMARY KEY, value TEXT)');

    database.exec("INSERT INTO data VALUES ('1', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.')");

    const session = database.createSession();
    database.exec("UPDATE data SET value = 'hi' WHERE key = 1");

    t.assert.ok(
      session.patchset().length < session.changeset().length,
      'expected patchset to be smaller than changeset');
  });

  test('session.close() - using session after close throws exception', (t) => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE data(key INTEGER PRIMARY KEY, value TEXT)');

    database.exec("INSERT INTO data VALUES ('1', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.')");

    const session = database.createSession();
    database.exec("UPDATE data SET value = 'hi' WHERE key = 1");
    session.close();

    database.exec("UPDATE data SET value = 'world' WHERE key = 1");
    t.assert.throws(() => {
      session.changeset();
    }, {
      name: 'Error',
      message: 'session is not open'
    });
  });

  test('session.close() - after closing database throws exception', (t) => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE data(key INTEGER PRIMARY KEY, value TEXT)');

    database.exec("INSERT INTO data VALUES ('1', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.')");

    const session = database.createSession();
    database.close();

    t.assert.throws(() => {
      session.close();
    }, {
      name: 'Error',
      message: 'database is not open'
    });
  });

  test('session.close() - closing twice', (t) => {
    const database = new DatabaseSync(':memory:');
    const session = database.createSession();
    session.close();

    t.assert.throws(() => {
      session.close();
    }, {
      name: 'Error',
      message: 'session is not open'
    });
  });
});
