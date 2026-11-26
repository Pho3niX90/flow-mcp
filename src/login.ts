#!/usr/bin/env node
// One-time setup per account: opens that account's own Chrome profile on Flow (or Flow Music with --music)
// so the user can sign in by hand.
// npm run login                 -> Flow for the main account
// npm run login -- work         -> Flow for the account called "work" (created first if it does not exist yet)
// npm run login -- --music      -> Flow Music window for the main account
// npm run login -- work --music -> Flow Music window for the account called "work"
import { accountByName, addAccount, listAccounts, MAIN, profileDir } from "./accounts.js";
import { getFlowPage, getMusicPage } from "./chrome.js";

const argv = process.argv.slice(2);
const music = argv.includes("--music");
const name = argv.find((a) => !a.startsWith("--")) ?? MAIN;
const account = listAccounts().find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? addAccount(name);
const target = accountByName(account.name);
const page = music ? await getMusicPage(target) : await getFlowPage(target);
await page.bringToFront();
console.log(`Chrome for account "${account.name}" is open on ${page.url()}`);
console.log(`Profile: ${profileDir(account)}`);
console.log(
  music
    ? 'Sign in with Google ("Log in" -> "Continue with Google") in that Flow Music window. The session is kept for next time.'
    : "Sign in to Google in that window, then open or create a Flow project. The session is kept for next time.",
);
process.exit(0);
