import postgres from "postgres";
import dotenv from "dotenv";

dotenv.config();

const sql = postgres(process.env.DB_URL, {
    ssl: {rejectUnauthorized:false}
});

export default sql;