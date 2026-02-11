# DB CLI - AI Assistant Rules

A CLI tool for managing database connections, imports, exports, and operations.

## 🏗️ Tech Stack

| Component   | Technology                 |
| ----------- | -------------------------- |
| Runtime     | Bun                        |
| Language    | TypeScript (strict mode)   |
| Database    | PostgreSQL (psql, pg_dump) |
| CLI Prompts | `@clack/prompts`           |
| Validation  | `zod`                      |

## 📁 Directory Structure

```
src/
├── index.ts              # Entry point
├── cli/
│   ├── app.ts            # Main App class
│   ├── types.ts          # Menu action enums
│   └── menus/            # Menu handlers
├── adapters/
│   └── postgres-adapter.ts
├── core/
│   └── config-manager.ts  # Singleton
├── helpers/
│   └── utils.ts
└── interfaces/
    └── index.ts
tests/                    # Bun test
```

## 📐 Code Patterns

### Menu File Organization

1. Imports
2. Types/Enums
3. Exported Menu Function (AT THE TOP)
4. Actions Map
5. Handler Functions

### Action Map Pattern

```typescript
// ❌ Don't use switch
// ✅ Use action map
const actions = { [MenuAction.Option1]: handleOption1 }
const handler = actions[action]
if (handler) await handler()
```

### Explicit Return Types

```typescript
// ❌ async function doSomething() {}
// ✅ async function doSomething(): Promise<void> {}
```

## 📝 Naming Conventions

| Type      | Convention       | Example               |
| --------- | ---------------- | --------------------- |
| Files     | kebab-case       | `database-actions.ts` |
| Functions | camelCase        | `showDatabaseMenu`    |
| Enums     | PascalCase       | `MainMenuAction`      |
| Constants | UPPER_SNAKE_CASE | `CONFIG_VERSION`      |

## ⚠️ Important Rules

1. Minimize exports - only export what's needed externally
2. Avoid comments - code should be self-documenting
3. No try-catch - errors should bubble up to `app.ts`
4. ConfigManager singleton: `ConfigManager.getInstance()`
5. Use Bun.spawn (not `child_process`)
6. **Always use `@/` path alias** - Never use relative imports (`../` or `./`)
    ```typescript
    // ❌ import { foo } from '../helpers/utils'
    // ✅ import { foo } from '@/helpers/utils'
    ```
    _Exception: `package.json` (outside src/) uses relative import_
7. **No `console.log`** - Use helpers from `@/helpers/utils`:
    - `logError(msg)` - Red error messages
    - `logSuccess(msg)` - Green success messages
    - `logWarn(msg)` - Yellow warnings
    - `logInfo(msg)` - Dim info messages
8. **Updating AI Rules**: When asking to update AI rules, you must:
    - Edit the relevant file in `.ruler/`
    - Run `bun run ruler` immediately after to regenerate the active rules.
9. **Comments**: Only add short comments when necessary. Avoid verbose explanations in code.

## 📦 Commands

```bash
bun run start      # Run app
bun run dev        # Watch mode
bun run check      # Types + Lint + Format + Knip (Run 'bun run fix' first!)
bun run fix        # Auto-fix lint & format issues (Always run this before 'check')
bun run knip       # Find unused code
bun run ruler      # Generate AI assistant rules
```
