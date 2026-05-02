# 🗄️ dbcli

A powerful, interactive CLI tool for managing database connections, imports, exports, and operations.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@ilhanaydinli/dbcli.svg)](https://www.npmjs.com/package/@ilhanaydinli/dbcli)

---

## ✨ Features

| Feature                      | Description                                                              |
| ---------------------------- | ------------------------------------------------------------------------ |
| 🔌 **Connection Management** | Save, edit, and manage multiple database configurations                  |
| 📥 **Import**                | Import dump files with optional DB reset, elapsed time display           |
| 📤 **Export**                | Backup databases with directory picker and persistent last-used path     |
| 🗃️ **Database Operations**   | Create, clone, rename, and drop databases                                |
| ⚙️ **Config Import/Export**  | Backup and restore connection settings (encrypted or plain)              |
| ⚡ **Fast Import Mode**      | LOCAL PostgreSQL only — aggressive server tuning for large dump imports  |

---

## 📦 Installation

### Prerequisites

- Database client tools for your target database:
    - **PostgreSQL:** `psql`, `pg_dump` (+ `pg_ctl`, `perl` for Fast Import Mode)
    - **MySQL/MariaDB:** `mysql`, `mysqldump`
    - **MongoDB:** `mongosh`, `mongodump`, `mongorestore`
    - **SQL Server:** none — uses the bundled `mssql` driver, no system tools required

### Install globally

```bash
bun install -g @ilhanaydinli/dbcli
```

---

## 🚀 Usage

```bash
dbcli
```

### Main Menu

```
┌  dbcli v1.8.0
│
◆  What would you like to do?
│  ● Import Database
│  ○ Export Database
│  ○ Manage Connections
│  ○ Settings
│  ○ Exit
└
```

---

## 📖 Commands

### 🔌 Manage Connections

Add, edit, list, or remove database connection configurations.

### 📥 Import Database

1. Select a saved connection
2. Select target database (or create a new one)
3. Pick a dump file using the interactive directory browser (remembers last-used path)
4. Optionally reset the database before import
5. Import executes using native database tools with elapsed time display

### 📤 Export Database

1. Select a saved connection
2. Select target database
3. Pick an output directory using the interactive directory browser (remembers last-used path)
4. Enter the output filename
5. Export creates a dump file using native tools with elapsed time display

### 🗃️ Database Operations

Manage databases on a selected connection:

- **Create** — Create a new database
- **Clone** — Duplicate an existing database
- **Rename** — Rename a database
- **Drop** — Delete a database (with confirmation)

### ⚙️ Settings

- **Toggle Verbose Mode** — Show/hide detailed command output
- **Toggle Fast Import Mode** — LOCAL PostgreSQL only: aggressive server optimizations for large imports
- **Toggle Skip Indexes** — LOCAL PostgreSQL only: skip secondary indexes during import (~45% faster)
- **Export Config** — Save connections to an encrypted or plain JSON file
- **Import Config** — Load connections from a JSON file

---

## ⚡ Fast Import Mode (LOCAL PostgreSQL only)

Dramatically speeds up large dump imports on a **local** PostgreSQL instance. Does **not** work with managed databases (Cloud SQL, RDS, Supabase, etc.).

Enable in **Settings → Toggle Fast Import Mode**.

| Setting                 | Normal    | Fast Mode |
| ----------------------- | --------- | --------- |
| fsync                   | on        | off       |
| full_page_writes        | on        | off       |
| wal_level               | replica   | minimal   |
| synchronous_commit      | on        | off       |
| autovacuum              | on        | off       |
| max_wal_size            | 1GB       | 64GB      |
| shared_buffers          | default   | RAM / 4   |
| Import wrapped in 1 txn | no        | yes       |
| PG restarted (×2)       | no        | yes       |

> ⚠️ A crash during import may corrupt the database. Use only on local dev or throwaway databases.

### Skip Indexes

Enable in **Settings → Toggle Skip Indexes** (requires Fast Import Mode ON).

Drops secondary `CREATE INDEX` statements during import while preserving `PRIMARY KEY` and `UNIQUE` indexes. Reduces import time by ~45% on large dumps. Queries will use sequential scans until indexes are rebuilt manually.

---

## 🗃️ Supported Databases

| Database      | Status       | Import | Export | Manage |
| ------------- | ------------ | ------ | ------ | ------ |
| PostgreSQL    | ✅ Supported | ✅     | ✅     | ✅     |
| MongoDB       | ✅ Supported | ✅     | ✅     | ✅     |
| MySQL         | ✅ Supported | ✅     | ✅     | ✅     |
| MariaDB       | ✅ Supported | ✅     | ✅     | ✅     |
| MS SQL Server | ✅ Supported | ✅     | ✅     | ✅     |

### SQL Server notes

- Authentication: SQL Server Authentication only (Windows Auth not yet supported).
- Export format: `.sql` containing `CREATE TABLE`, `INSERT INTO`, indexes, foreign keys, CHECK constraints, computed columns, and `DBCC CHECKIDENT` reseed for IDENTITY columns.
- Dump scope covers **tables, primary keys, unique indexes, foreign keys, CHECK constraints, computed columns, multiple schemas, and identity reseed**. Views, stored procedures, triggers, and functions are **not included** in dumps.
- Verified against SQL Server 2017 and 2022 (Linux Docker). Should also work on 2014/2016 since all queries use `sys.*` views available since 2005, but not empirically tested.
- Connection URL formats accepted: `mssql://user:pass@host:1433/database` or `sqlserver://...`.

---

## 📜 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
