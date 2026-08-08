import * as readline from "node:readline";

/** Plain visible-input prompt. */
export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Built via fromCharCode rather than literal escapes in source — control
// characters embedded directly in a source string are easy to corrupt
// invisibly when a file passes through text-oriented tooling.
const KEY_ENTER = ["\n", "\r"];
const KEY_EOF = String.fromCharCode(4); // Ctrl-D
const KEY_INTERRUPT = String.fromCharCode(3); // Ctrl-C
const KEY_BACKSPACE = String.fromCharCode(127); // Backspace/Delete

/**
 * Password prompt that never echoes the typed characters — used so a
 * secret never lands in shell history or a terminal scrollback buffer.
 */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);

    let value = "";
    const onData = (char: Buffer) => {
      const c = char.toString("utf8");
      if (KEY_ENTER.includes(c) || c === KEY_EOF) {
        stdin.removeListener("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (c === KEY_INTERRUPT) {
        process.stdout.write("\n");
        process.exit(1);
      }
      if (c === KEY_BACKSPACE) {
        value = value.slice(0, -1);
        return;
      }
      value += c;
    };

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}
