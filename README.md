# 🗄️ dbcli

A powerful, interactive CLI tool for managing database connections, imports, exports, and operations.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@ilhanaydinli/dbcli.svg)](https://www.npmjs.com/package/@ilhanaydinli/dbcli)

---

## ✨ Features

| Feature                      | Description                                             |
| ---------------------------- | ------------------------------------------------------- |
| 🔌 **Connection Management** | Save, edit, and manage multiple database configurations |
| 📥 **Import**                | Import dump files with optional DB reset before import  |
| 📤 **Export**                | Backup databases to custom-named dump files             |
| 🗃️ **Database Operations**   | Create, clone, rename, and drop databases               |
| ⚙️ **Config Import/Export**  | Backup and restore your connection settings             |

---

## 📦 Installation

### Prerequisites

- Database client tools for your target database:
    - **PostgreSQL:** `psql`, `pg_dump`
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
# Start the interactive CLI
dbcli
```

### Main Menu

```
┌  dbcli v1.0.0
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
3. Select a dump file from the current directory
4. Optionally reset the database before import
5. Import executes using native database tools

### 📤 Export Database

1. Select a saved connection
2. Enter the output filename
3. Export creates a dump file using native tools

### 🗃️ Database Operations

Manage databases on a selected connection:

- **Create** — Create a new database
- **Clone** — Duplicate an existing database
- **Rename** — Rename a database
- **Drop** — Delete a database (with confirmation)

### ⚙️ Settings

- **Toggle Verbose Mode** — Show/hide detailed output
- **Export Config** — Save connections to a JSON file
- **Import Config** — Load connections from a JSON file

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
- Verified against SQL Server 2017 and 2022 (Linux Docker). Should also work on 2014/2016 since all queries use `sys.*` views available since 2005, but not empirically tested (Microsoft has no Linux Docker image for those).
- Connection URL formats accepted: `mssql://user:pass@host:1433/database` or `sqlserver://...`.

---

## 📜 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
