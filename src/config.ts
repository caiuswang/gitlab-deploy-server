import dotenv from "dotenv";
dotenv.config();

export const SERVER_PORT = process.env.SERVER_PORT || "3000";
export const DATABASE_URL = process.env.DATABASE_URL || "database.db";
export const GITLAB_SCHEME = process.env.GITLAB_SCHEME || "https";
export const GITLAB_HOST = process.env.GITLAB_HOST || "";
export const GITLAB_TOKEN = process.env.GITLAB_TOKEN || "";
export const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
