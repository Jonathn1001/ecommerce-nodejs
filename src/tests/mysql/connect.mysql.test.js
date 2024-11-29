const mysql = require("mysql2/promise");
const dotenv = require("dotenv");
dotenv.config();

const { MYSQL_DB_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } =
  process.env;

// Verify env variables
if (!MYSQL_DB_HOST || !MYSQL_USER || !MYSQL_PASSWORD || !MYSQL_DATABASE) {
  throw new Error("Missing required environment variables");
}

const pool = mysql.createPool({
  host: MYSQL_DB_HOST,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  connectionLimit: 10,
  waitForConnections: true,
});

async function insertBatch() {
  try {
    console.time("Total Insert Time");

    // Get current max ID
    const connection = await pool.getConnection();
    const [maxResult] = await connection.query(
      "SELECT MAX(id) as maxId FROM users"
    );
    const startId = (maxResult[0].maxId || 0) + 1;
    const increment = 1000000; // Add 1M records each run
    const targetId = startId + increment - 1;
    connection.release();

    console.log(`Starting from ID ${startId}, targeting up to ID ${targetId}`);

    let currentId = startId;
    const batchSize = 100000;
    const batchStartId = currentId;
    while (currentId <= targetId) {
      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        const values = [];

        const currentBatchSize = Math.min(batchSize, targetId - currentId + 1);

        for (let i = 0; i < currentBatchSize; i++) {
          values.push([
            currentId + i,
            `user${currentId + i}`,
            Math.floor(Math.random() * 100),
            `user${currentId + i}@example.com`,
          ]);
        }

        const [results] = await connection.query(
          "INSERT INTO users (id, username, age, email) VALUES ?",
          [values]
        );

        await connection.commit();

        const progress = (((currentId - startId) / increment) * 100).toFixed(2);
        console.log(`Batch inserted: ${results.affectedRows} rows`);
        console.log(
          `Progress: ${progress}% (${currentId - startId}/${increment})`
        );

        currentId += currentBatchSize;
      } catch (error) {
        await connection.rollback();
        console.error(
          `Error in batch ${batchStartId}-${currentId - 1}:`,
          error
        );
        currentId = batchStartId; // Retry this batch
      } finally {
        connection.release();
      }
    }

    console.timeEnd("Total Insert Time");
  } catch (error) {
    console.error("Fatal error:", error);
  } finally {
    await pool.end();
  }
}

insertBatch().catch(console.error);
