"use strict";

const EXTENSION_NAME = "quadre-eslint";

function log(level, msgs) {
    return console[level].apply(console, ["[" + EXTENSION_NAME + "]"].concat(msgs));
}

export function info(...msgs) {
    return log("log", msgs);
}

export function error(...msgs) {
    return log("error", msgs);
}
