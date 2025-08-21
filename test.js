require("dotenv").config();
const { Client } = require("pg");
const dns = require("dns").promises;

async function testConnection() {
  try {
    console.log("⏳ Resolving Supabase host to IPv4...");
    const addresses = await dns.lookup("db.idgrfypntnjlphmqqgnp.supabase.co", { family: 4 });
    console.log("✅ IPv4 Address:", addresses.address);

    const client = new Client({
      connectionString: process.env.DB_URL.replace(
        "db.idgrfypntnjlphmqqgnp.supabase.co",
        addresses.address
      ),
      ssl: { rejectUnauthorized: false }
    });

    console.log("⏳ Connecting to Supabase PostgreSQL...");
    await client.connect();
    console.log("✅ Connected!");

    const res = await client.query("SELECT NOW()");
    console.log("📅 Server time:", res.rows[0]);

    await client.end();
  } catch (err) {
    console.error("❌ Connection error:", err.message);
  }
}

testConnection();