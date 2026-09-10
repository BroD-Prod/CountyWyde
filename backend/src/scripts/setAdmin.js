require("dotenv").config();
const db = require("../lib/db");

async function main() {
    const [usernameArg, flagArg] = process.argv.slice(2);
    const username = String(usernameArg || "").trim().toLowerCase();
    const isAdmin = flagArg === undefined ? true : flagArg !== "false";

    if (!username) {
        console.error("Usage: node src/scripts/setAdmin.js <username> [true|false]");
        process.exitCode = 1;
        return;
    }

    const account = await db
        .prepare("SELECT id, username, is_admin FROM accounts WHERE LOWER(username) = LOWER(?) LIMIT 1")
        .get(username);

    if (!account) {
        console.error(`No account found for username: ${username}`);
        process.exitCode = 1;
        return;
    }

    await db
        .prepare("UPDATE accounts SET is_admin = ? WHERE id = ?")
        .run(isAdmin, account.id);

    console.log(
        `${account.username} is now ${isAdmin ? "an admin" : "no longer an admin"}.`,
    );
}

main().catch((error) => {
    console.error("Failed to update admin flag:", error.message || error);
    process.exitCode = 1;
});
