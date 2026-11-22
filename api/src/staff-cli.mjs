// Staff account administration against the database. This is how the first admin is created (no one can sign in yet).
//   node src/staff-cli.mjs create-user <email> <staff|approver|admin> "<display name>"
//   node src/staff-cli.mjs set-password <email>
//   node src/staff-cli.mjs disable <email>
//   node src/staff-cli.mjs list
// The password is read from STAFF_NEW_PASSWORD, never from the command line (shell history, process lists).
import { pathToFileURL } from "node:url";
import { createStaffAuth, normalizeEmail } from "./auth.mjs";

export async function run(db, args, env = {}, out = console.log) {
  const auth = createStaffAuth({ db, mode: "users" });
  const [cmd, ...rest] = args;
  const pw = env.STAFF_NEW_PASSWORD;
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  switch (cmd) {
    case "create-user": {
      const [email, role, ...name] = rest;
      need(email && role && name.length, 'usage: create-user <email> <role> "<display name>" (password in STAFF_NEW_PASSWORD)');
      need(pw, "set STAFF_NEW_PASSWORD");
      const u = await auth.createUser({ email, role, displayName: name.join(" "), password: pw });
      out(`created ${u.role} ${u.email}`);
      return u;
    }
    case "set-password": {
      need(rest[0] && pw, "usage: set-password <email> (password in STAFF_NEW_PASSWORD)");
      const u = await auth.setPassword(rest[0], pw);
      out(`password reset for ${u.email}; all sessions revoked`);
      return u;
    }
    case "disable": {
      need(rest[0], "usage: disable <email>");
      const row = (await db.query("SELECT id FROM staff_users WHERE email = $1", [normalizeEmail(rest[0])])).rows[0];
      need(row, "no such user");
      const u = await auth.disableUser(row.id);
      out(`disabled ${u.email}`);
      return u;
    }
    case "list": {
      const users = await auth.listUsers();
      for (const u of users) out(`${u.email}\t${u.role}\t${u.disabled ? "disabled" : "active"}\t${u.displayName}`);
      return users;
    }
    default:
      throw new Error("commands: create-user, set-password, disable, list");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pg } = await import("pg");
  const { pgAdapter, migrate } = await import("./db/adapters.mjs");
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = pgAdapter(pool);
  try {
    await migrate(db);
    await run(db, process.argv.slice(2), process.env);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
