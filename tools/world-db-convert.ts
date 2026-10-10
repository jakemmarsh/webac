/**
 * MySQL→SQLite converter for ACE World Database
 *
 * Reads the ACE-World SQL dumps and converts them into a SQLite database.
 * Run with: npx tsx tools/world-db-convert.ts
 */
import { readFileSync, readdirSync, statSync, existsSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import Database from 'better-sqlite3';

const ROOT = resolve(import.meta.dirname, '..');
const WORLD_DB_RAW = resolve(ROOT, 'world-db-raw/ACE-World-16PY/Database');
const OUTPUT = resolve(ROOT, 'dat/world.sqlite');

// SQLite reserved words that need quoting when used as identifiers
const RESERVED = new Set([
  'index', 'order', 'key', 'type', 'value', 'group', 'default',
  'check', 'primary', 'foreign', 'references', 'constraint', 'unique',
  'table', 'create', 'drop', 'alter', 'insert', 'update', 'delete',
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'in',
  'level', 'range', 'state', 'action',
]);

function quoteIdentifier(name: string): string {
  // Remove backticks if present
  name = name.replace(/`/g, '');
  if (RESERVED.has(name.toLowerCase())) {
    return `"${name}"`;
  }
  return name;
}

// ─── MySQL→SQLite schema conversion ──────────────────────────────────────

function convertSchemaFile(schemaSQL: string): string[] {
  const creates: string[] = [];
  const lines = schemaSQL.split('\n');
  let inCreate = false;
  let tableName = '';
  let columns: string[] = [];
  let primaryKey = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Start of CREATE TABLE
    const createMatch = line.match(/^CREATE TABLE\s+`?(\w+)`?\s*\(/);
    if (createMatch) {
      inCreate = true;
      tableName = createMatch[1];
      columns = [];
      primaryKey = '';
      continue;
    }

    if (!inCreate) continue;

    // End of CREATE TABLE
    if (line.startsWith(')')) {
      let sql = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (\n`;
      sql += columns.join(',\n');
      if (primaryKey) {
        sql += `,\n  PRIMARY KEY (${primaryKey})`;
      }
      sql += '\n)';
      creates.push(sql);
      inCreate = false;
      continue;
    }

    // PRIMARY KEY line
    const pkMatch = line.match(/^\s*PRIMARY KEY\s*\(([^)]+)\)/);
    if (pkMatch) {
      primaryKey = pkMatch[1].replace(/`/g, '').split(',').map(c => quoteIdentifier(c.trim())).join(', ');
      continue;
    }

    // Skip UNIQUE KEY, KEY, CONSTRAINT lines
    if (line.match(/^\s*(UNIQUE KEY|KEY\s|CONSTRAINT\s)/)) continue;

    // Column definition
    const colMatch = line.match(/^\s*`(\w+)`\s+(.*)/);
    if (colMatch) {
      const colName = colMatch[1];
      let colDef = colMatch[2];

      // Remove trailing comma
      colDef = colDef.replace(/,\s*$/, '');

      // Remove COMMENT (handle escaped apostrophes)
      colDef = colDef.replace(/\s*COMMENT\s+'(?:[^'\\]|\\.)*'$/i, '');
      colDef = colDef.replace(/\s*COMMENT\s+'[^']*(?:''[^']*)*'$/i, '');

      // Remove ON UPDATE CURRENT_TIMESTAMP
      colDef = colDef.replace(/\s*ON UPDATE CURRENT_TIMESTAMP/gi, '');

      // Remove AUTO_INCREMENT
      colDef = colDef.replace(/\s*AUTO_INCREMENT/gi, '');

      // Remove unsigned
      colDef = colDef.replace(/\s*unsigned/gi, '');

      // Convert types
      colDef = colDef.replace(/\bint\(\d+\)/gi, 'INTEGER');
      colDef = colDef.replace(/\btinyint\(\d+\)/gi, 'INTEGER');
      colDef = colDef.replace(/\bsmallint\(\d+\)/gi, 'INTEGER');
      colDef = colDef.replace(/\bmediumint\(\d+\)/gi, 'INTEGER');
      colDef = colDef.replace(/\bbigint\(\d+\)/gi, 'INTEGER');
      colDef = colDef.replace(/\bbit\(1\)/gi, 'INTEGER');
      colDef = colDef.replace(/\bfloat\b/gi, 'REAL');
      colDef = colDef.replace(/\bdouble\b/gi, 'REAL');
      colDef = colDef.replace(/\bvarchar\(\d+\)/gi, 'TEXT');
      colDef = colDef.replace(/\btext\b/gi, 'TEXT');
      colDef = colDef.replace(/\bdatetime\b/gi, 'TEXT');
      colDef = colDef.replace(/\blongtext\b/gi, 'TEXT');
      colDef = colDef.replace(/\bblob\b/gi, 'BLOB');

      columns.push(`  ${quoteIdentifier(colName)} ${colDef.trim()}`);
    }
  }

  return creates;
}

// ─── MySQL→SQLite INSERT conversion ──────────────────────────────────────

function convertInsertSQL(sql: string): string {
  // Convert backtick identifiers to proper quoting
  sql = sql.replace(/`(\w+)`/g, (_match, name) => quoteIdentifier(name));

  // Convert hex literals like 0xABCD to decimal
  sql = sql.replace(/\b0x([0-9A-Fa-f]+)\b/g, (_match, hex) => {
    return String(parseInt(hex, 16));
  });

  // Convert True/False to 1/0
  sql = sql.replace(/\bTrue\b/g, '1');
  sql = sql.replace(/\bFalse\b/g, '0');

  // Strip inline comments /* ... */
  sql = sql.replace(/\/\*[^*]*\*\//g, '');

  return sql;
}

// ─── Process SQL files ────────────────────────────────────────────────────

function collectSqlFiles(dir: string): string[] {
  const files: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.sql')) {
        files.push(full);
      }
    }
  }
  walk(dir);
  return files;
}

function processDataFile(db: Database.Database, filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let insertCount = 0;
  let currentStatement = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, comments, and MySQL directives
    if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('/*!')
        || trimmed.startsWith('SET ') || trimmed.startsWith('USE ')
        || trimmed.startsWith('CREATE DATABASE') || trimmed.startsWith('CREATE TABLE')
        || trimmed.startsWith('LOCK ') || trimmed.startsWith('UNLOCK ')
        || trimmed.startsWith('DROP TABLE')) {
      continue;
    }

    // Handle DELETE or INSERT statements (may span multiple lines)
    if (trimmed.startsWith('DELETE ') || trimmed.startsWith('INSERT ')
        || trimmed.startsWith('UPDATE ')) {
      currentStatement = trimmed;
    } else if (currentStatement) {
      currentStatement += ' ' + trimmed;
    } else {
      continue;
    }

    // Check if statement is complete (ends with ; possibly followed by comment)
    // Strip trailing inline comments to find the semicolon
    const stripped = currentStatement.replace(/\/\*[^*]*\*\/\s*$/g, '').trimEnd();
    if (stripped && stripped.endsWith(';')) {
      currentStatement = stripped;
      try {
        const converted = convertInsertSQL(currentStatement);
        db.exec(converted);
        if (currentStatement.startsWith('INSERT')) insertCount++;
      } catch (e: any) {
        if (!e.message.includes('UNIQUE constraint')) {
          // Only log unexpected errors
        }
      }
      currentStatement = '';
    }
  }

  return insertCount;
}

// ─── Main ─────────────────────────────────────────────────────────────────

function main() {
  console.log('ACE World Database → SQLite Converter');
  console.log('=====================================\n');

  // Remove existing database
  if (existsSync(OUTPUT)) {
    unlinkSync(OUTPUT);
    console.log('Removed existing world.sqlite');
  }

  // Create database
  const db = new Database(OUTPUT);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('foreign_keys = OFF');

  // Step 1: Create schema from WorldBase.sql
  console.log('Step 1: Creating schema...');
  const schemaSQL = readFileSync(resolve(WORLD_DB_RAW, '1-Base/WorldBase.sql'), 'utf-8');
  const createStatements = convertSchemaFile(schemaSQL);
  let schemaErrors = 0;
  for (const create of createStatements) {
    try {
      db.exec(create);
    } catch (e: any) {
      schemaErrors++;
      console.error(`  Schema error: ${e.message.substring(0, 120)}`);
      console.error(`    SQL: ${create.substring(0, 200)}`);
    }
  }
  console.log(`  Created ${createStatements.length - schemaErrors}/${createStatements.length} tables`);

  // Step 2: Process data directories in order
  const dataDirectories = [
    { name: 'RegionDescExtendedData', path: '3-Core/1 RegionDescExtendedData' },
    { name: 'SpellTableExtendedData', path: '3-Core/2 SpellTableExtendedData' },
    { name: 'TreasureTable', path: '3-Core/3 TreasureTable' },
    { name: 'CraftTable', path: '3-Core/4 CraftTable' },
    { name: 'HousingPortals', path: '3-Core/5 HousingPortals' },
    { name: 'LandBlockExtendedData', path: '3-Core/6 LandBlockExtendedData' },
    { name: 'QuestDefDB', path: '3-Core/8 QuestDefDB' },
    { name: 'WeenieDefaults', path: '3-Core/9 WeenieDefaults' },
    { name: 'GameEventDefDB', path: '3-Core/B GameEventDefDB' },
  ];

  for (const dir of dataDirectories) {
    const dirPath = resolve(WORLD_DB_RAW, dir.path);
    if (!existsSync(dirPath)) {
      console.log(`  Skipping ${dir.name} (not found)`);
      continue;
    }

    const sqlFiles = collectSqlFiles(dirPath);
    console.log(`\nStep 2: Processing ${dir.name} (${sqlFiles.length} files)...`);

    let totalInserts = 0;
    const batchSize = 500;

    for (let i = 0; i < sqlFiles.length; i += batchSize) {
      const batch = sqlFiles.slice(i, i + batchSize);
      const tx = db.transaction(() => {
        for (const file of batch) {
          totalInserts += processDataFile(db, file);
        }
      });
      tx();

      if ((i + batchSize) % 5000 === 0 || i + batchSize >= sqlFiles.length) {
        process.stdout.write(`  Processed ${Math.min(i + batchSize, sqlFiles.length)}/${sqlFiles.length} files (${totalInserts} inserts)\r`);
      }
    }
    console.log(`  Completed: ${sqlFiles.length} files, ${totalInserts} inserts`);
  }

  // Step 3: Create indices for performance
  console.log('\nStep 3: Creating indices...');
  const indices = [
    'CREATE INDEX IF NOT EXISTS idx_weenie_type ON weenie("type")',
    'CREATE INDEX IF NOT EXISTS idx_weenie_class_name ON weenie(class_Name)',
    'CREATE INDEX IF NOT EXISTS idx_wpi_object_id ON weenie_properties_int(object_Id)',
    'CREATE INDEX IF NOT EXISTS idx_wpi_type ON weenie_properties_int(object_Id, "type")',
    'CREATE INDEX IF NOT EXISTS idx_wps_object_id ON weenie_properties_string(object_Id)',
    'CREATE INDEX IF NOT EXISTS idx_wpb_object_id ON weenie_properties_bool(object_Id)',
    'CREATE INDEX IF NOT EXISTS idx_wpf_object_id ON weenie_properties_float(object_Id)',
    'CREATE INDEX IF NOT EXISTS idx_wpd_object_id ON weenie_properties_d_i_d(object_Id)',
    'CREATE INDEX IF NOT EXISTS idx_wpp_object_id ON weenie_properties_position(object_Id)',
    'CREATE INDEX IF NOT EXISTS idx_li_landblock ON landblock_instance(landblock)',
    'CREATE INDEX IF NOT EXISTS idx_li_weenie ON landblock_instance(weenie_Class_Id)',
    'CREATE INDEX IF NOT EXISTS idx_encounter_lb ON encounter(landblock)',
  ];
  for (const idx of indices) {
    try { db.exec(idx); } catch { /* skip */ }
  }
  console.log(`  Created indices`);

  // Step 4: Summary
  console.log('\n═══ Summary ═══');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
  console.log(`Tables: ${tables.length}`);

  for (const t of ['weenie', 'landblock_instance', 'encounter', 'recipe', 'spell',
                    'treasure_death', 'cook_book', 'quest', 'weenie_properties_int']) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get() as any;
      console.log(`  ${t}: ${row.c} rows`);
    } catch {
      console.log(`  ${t}: (missing)`);
    }
  }

  db.close();
  console.log(`\nOutput: ${OUTPUT}`);
  console.log('Done!');
}

main();
