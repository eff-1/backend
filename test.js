import sql from "./db.js";

(async () => {
  try {
    const result = await sql`SELECT NOW() AS now`;
    console.log("✅ DB connected:", result[0].now);
    process.exit(0);
  } catch (err) {
    console.error("❌ DB connection failed:", err.message);
    process.exit(1);
  }
})();
