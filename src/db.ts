import path from "path";
import Database from "better-sqlite3";
import { DATABASE_URL } from "./config";
import { PrismaClient } from './generated/prisma'

export const prisma = new PrismaClient();

// dist/ -> ts-deploy-server/ -> repo-root
const resolved = path.isAbsolute(DATABASE_URL)
  ? DATABASE_URL
  : path.resolve(__dirname, "..", "..", DATABASE_URL);

export const db = new Database(resolved, { fileMustExist: true });