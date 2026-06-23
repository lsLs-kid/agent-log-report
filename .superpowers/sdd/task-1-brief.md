## Task 1: Project Scaffolding

**Files:**
- Create: `log-sync/package.json`
- Create: `log-sync/tsconfig.json`
- Create: `log-sync/.gitignore`

**Interfaces:**
- Produces: `log-sync/` directory ready for TypeScript development.

- [ ] **Step 1: Create package.json**

Create `log-sync/package.json`:

```json
{
  "name": "log-sync",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "log-sync": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "pg": "^8.12.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.14.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.15.0",
    "typescript": "^5.4.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `log-sync/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create .gitignore**

Create `log-sync/.gitignore`:

```gitignore
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 4: Install dependencies**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Verify TypeScript compiles empty project**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds with no output.

---

