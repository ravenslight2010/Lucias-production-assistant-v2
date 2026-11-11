import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { generateDrizzleJson, pushSchema } from "drizzle-kit/api";
import * as schema from "../src/schema/production.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set before pushing the schema.");
}

function finalIdentifier(qualifiedName) {
  return qualifiedName
    .trim()
    .split(".")
    .at(-1)
    .replace(/^"/, "")
    .replace(/"$/, "")
    .replaceAll('""', '"');
}

function dropTarget(statement) {
  const indexDrop = statement.match(
    /\bDROP\s+INDEX(?:\s+IF\s+EXISTS)?\s+((?:"(?:""|[^"])*"|[A-Za-z_][\w$]*)(?:\.(?:"(?:""|[^"])*"|[A-Za-z_][\w$]*))?)/i,
  );
  if (indexDrop) {
    return { kind: "index", name: finalIdentifier(indexDrop[1]) };
  }
  const constraintDrop = statement.match(
    /\bDROP\s+CONSTRAINT(?:\s+IF\s+EXISTS)?\s+("(?:[^"]|"")*"|[A-Za-z_][\w$]*)/i,
  );
  if (!constraintDrop) return null;

  const tableName = statement.match(
    /\bALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+((?:"(?:""|[^"])*"|[A-Za-z_][\w$]*)(?:\.(?:"(?:""|[^"])*"|[A-Za-z_][\w$]*))?)/i,
  );
  if (!tableName) return null;
  return {
    kind: "check",
    table: finalIdentifier(tableName[1]),
    name: finalIdentifier(constraintDrop[1]),
  };
}

function affectedTableByDestructiveDrop(statement) {
  const droppedTable = statement.match(
    /\bDROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+((?:"(?:""|[^"])*"|[A-Za-z_][\w$]*)(?:\.(?:"(?:""|[^"])*"|[A-Za-z_][\w$]*))?)/i,
  );
  if (droppedTable) return finalIdentifier(droppedTable[1]);

  if (!/\bDROP\s+COLUMN\b/i.test(statement)) return null;
  const alteredTable = statement.match(
    /\bALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+((?:"(?:""|[^"])*"|[A-Za-z_][\w$]*)(?:\.(?:"(?:""|[^"])*"|[A-Za-z_][\w$]*))?)/i,
  );
  return alteredTable ? finalIdentifier(alteredTable[1]) : null;
}

function generatedSafeguards(schemaImports) {
  const generated = generateDrizzleJson(schemaImports);
  const indexes = new Set();
  const checks = new Set();

  for (const [tableKey, table] of Object.entries(generated.tables)) {
    const [schemaName] = tableKey.split(".");
    if (
      Object.values(table.columns ?? {}).some((column) => column.primaryKey)
    ) {
      indexes.add(`${schemaName}.${table.name}_pkey`);
    }
    for (const indexName of Object.keys(table.indexes ?? {})) {
      indexes.add(`${schemaName}.${indexName}`);
    }
    for (const constraintName of Object.keys(
      table.compositePrimaryKeys ?? {},
    )) {
      indexes.add(`${schemaName}.${constraintName}`);
    }
    for (const constraintName of Object.keys(table.uniqueConstraints ?? {})) {
      indexes.add(`${schemaName}.${constraintName}`);
    }
    for (const checkName of Object.keys(table.checkConstraints ?? {})) {
      checks.add(`${schemaName}.${table.name}.${checkName}`);
    }
  }

  return { indexes, checks };
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const db = drizzle(pool);

try {
  const plan = await pushSchema(schema, db, ["public"]);
  const generated = generatedSafeguards(schema);
  const [databaseIndexes, databaseChecks] = await Promise.all([
    pool.query(
      `SELECT schemaname, indexname
       FROM pg_indexes
       WHERE schemaname = ANY($1)`,
      [["public"]],
    ),
    pool.query(
      `SELECT namespaces.nspname AS schemaname,
              tables.relname AS tablename,
              constraints.conname AS constraintname
       FROM pg_constraint AS constraints
       JOIN pg_class AS tables ON tables.oid = constraints.conrelid
       JOIN pg_namespace AS namespaces ON namespaces.oid = tables.relnamespace
       WHERE constraints.contype = 'c'
         AND namespaces.nspname = ANY($1)`,
      [["public"]],
    ),
  ]);
  const unmanagedIndexRows = databaseIndexes.rows.filter(
    ({ schemaname, indexname }) =>
      !generated.indexes.has(`${schemaname}.${indexname}`),
  );
  const unmanagedCheckRows = databaseChecks.rows.filter(
    ({ schemaname, tablename, constraintname }) =>
      !generated.checks.has(`${schemaname}.${tablename}.${constraintname}`),
  );
  const unmanagedIndexes = new Set(
    unmanagedIndexRows.map(({ indexname }) => indexname),
  );
  const unmanagedChecks = new Set(
    unmanagedCheckRows.map(
      ({ tablename, constraintname }) => `${tablename}.${constraintname}`,
    ),
  );
  const safeguardedTables = new Set([
    ...unmanagedIndexRows.map(({ tablename }) => tablename),
    ...unmanagedCheckRows.map(({ tablename }) => tablename),
  ]);
  const unsafeTableDrops = plan.statementsToExecute.filter((statement) => {
    const tableName = affectedTableByDestructiveDrop(statement);
    return tableName && safeguardedTables.has(tableName);
  });
  if (unsafeTableDrops.length > 0) {
    throw new Error(
      "Schema push would drop a table or column that has an undeclared index or check constraint. " +
        "Move the safeguard first, or update it explicitly before retrying.",
    );
  }

  const shouldPreserveDrop = (statement) => {
    const target = dropTarget(statement);
    if (!target) return false;
    if (target.kind === "index") {
      return unmanagedIndexes.has(target.name);
    }
    return unmanagedChecks.has(`${target.table}.${target.name}`);
  };
  const preservedDrops = plan.statementsToExecute.filter(shouldPreserveDrop);
  const statementsToExecute = plan.statementsToExecute.filter(
    (statement) => !shouldPreserveDrop(statement),
  );
  const needsConfirmation = plan.hasDataLoss || preservedDrops.length > 0;
  const strict = process.env.DRIZZLE_PUSH_STRICT !== "false";

  if (preservedDrops.length > 0) {
    console.log(
      `Preserving ${preservedDrops.length} database index/check constraint(s) ` +
        `not declared in the generated schema.`,
    );
  }

  if (strict && needsConfirmation) {
    for (const warning of plan.warnings) {
      console.log(warning);
    }
    console.log("No, abort");
    console.log("Yes, apply the remaining schema changes");

    if (!stdin.isTTY) {
      throw new Error(
        "Schema changes need confirmation. Run this command in a terminal or set DRIZZLE_PUSH_STRICT=false after reviewing the plan.",
      );
    }

    const prompt = createInterface({ input: stdin, output: stdout });
    const answer = await prompt.question(
      "Apply the listed changes while preserving custom safeguards? [y/N] ",
    );
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("All changes were aborted");
      process.exitCode = 0;
    } else {
      for (const statement of statementsToExecute) {
        await db.execute(sql.raw(statement));
      }
      console.log("[✓] Changes applied; custom safeguards were preserved");
    }
  } else {
    for (const statement of statementsToExecute) {
      await db.execute(sql.raw(statement));
    }
    console.log(
      statementsToExecute.length === 0
        ? "[✓] No schema changes"
        : "[✓] Changes applied; custom safeguards were preserved",
    );
  }
} finally {
  await pool.end();
}
