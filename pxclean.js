const fs = require("fs");
const vm = require("vm");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const PARSE_OPTS = {
    sourceType: "script",
    errorRecovery: true,
    allowReturnOutsideFunction: true
};
const GEN_OPTS = {
    compact: false,
    jsescOption: {
        minimal: true
    }
};

// PX basE91 variant + bytes -> utf8
function basE91(alpha, str) {
    let n = "" + (str || ""),
        e = n.length,
        r = [],
        i = 0,
        h = 0,
        c = -1;
    for (let o = 0; o < e; o++) {
        const a = alpha.indexOf(n[o]);
        if (a === -1) continue;
        if (c < 0) {
            c = a;
        } else {
            i |= (c += 91 * a) << h;
            h += (8191 & c) > 88 ? 13 : 14;
            do {
                r.push(255 & i);
                i >>= 8;
                h -= 8;
            } while (h > 7);
            c = -1;
        }
    }
    if (c > -1) r.push(255 & (i | c << h));
    return Buffer.from(r).toString("utf-8");
}
const isPrintable = (s) => /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s);
function buildResolvers(ast) {
    // Pass 1: basE91 decoder functions and their 91 char alphabet
    const decoderAlphabet = new Map();
    traverse(ast, {
        StringLiteral(path) {
            const s = path.node.value;
            if (s.length !== 91) return;
            const mem = path.parentPath;
            if (!mem.isMemberExpression() || mem.node.object !== path.node) return;
            if (!t.isIdentifier(mem.node.property, {
                    name: "indexOf"
                })) return;
            const fn = path.getFunctionParent();
            if (fn) decoderAlphabet.set(fn.node, s);
        },
    });
    // Pass 2: string-table accessors | X[p] = DECODER(TABLE[p])
    const accessorByBinding = new Map();
    const tableCache = new Map();
    const safe = (alphabet, s) => {
        try {
            return basE91(alphabet, s);
        } catch (e) {
            return null;
        }
    };
    const tableFor = (alphabet, arrNode) => {
        const key = alphabet + "@" + (arrNode.__id || (arrNode.__id = Math.random()));
        if (tableCache.has(key)) return tableCache.get(key);
        const dec = arrNode.elements.map(el => (t.isStringLiteral(el) ? safe(alphabet, el.value) : null));
        tableCache.set(key, dec);
        return dec;
    };
    traverse(ast, {
        Function(path) {
            if (path.node.params.length !== 1 || !t.isIdentifier(path.node.params[0])) return;
            const param = path.node.params[0].name;
            let found = null;
            path.traverse({
                AssignmentExpression(a) {
                    const r = a.node.right;
                    if (!t.isCallExpression(r) || r.arguments.length !== 1) return;
                    const arg = r.arguments[0];
                    if (!t.isMemberExpression(arg) || !arg.computed) return;
                    if (!t.isIdentifier(arg.object) || !t.isIdentifier(arg.property, {
                            name: param
                        })) return;
                    if (t.isIdentifier(r.callee)) found = {
                        decoderName: r.callee.name,
                        tableName: arg.object.name,
                        inlineAlpha: null
                    };
                    else if (t.isFunctionExpression(r.callee) || t.isArrowFunctionExpression(r.callee)) found = {
                        decoderName: null,
                        tableName: arg.object.name,
                        inlineAlpha: decoderAlphabet.get(r.callee)
                    };
                    else return;
                    a.stop();
                },
            });
            if (!found) return;
            let alphabet = found.inlineAlpha;
            if (!alphabet && found.decoderName) {
                const decBind = path.scope.getBinding(found.decoderName);
                if (decBind) alphabet = decoderAlphabet.get(decBind.path.node);
            }
            if (!alphabet) return;
            const tblBind = path.scope.getBinding(found.tableName);
            if (!tblBind || !t.isVariableDeclarator(tblBind.path.node) || !t.isArrayExpression(tblBind.path.node.init)) return;
            const arrNode = tblBind.path.node.init;
            const name = path.node.id ? path.node.id.name : (t.isVariableDeclarator(path.parent) ? path.parent.id.name : null);
            if (!name) return;
            const enclosing = path.scope.parent || path.scope;
            const accBind = enclosing.getBinding(name);
            if (!accBind) return;
            accessorByBinding.set(accBind, {
                decoded: tableFor(alphabet, arrNode)
            });
        },
    });
    return accessorByBinding;
}
// Stage 1: deobfuscate(code) -> code
const isPureInit = (n) => n == null || t.isFunctionExpression(n) || t.isArrowFunctionExpression(n) ||
    t.isLiteral(n) || t.isArrayExpression(n) || t.isObjectExpression(n) || t.isIdentifier(n);

function deadCodeEliminate(src) {
    let removed = 0,
        iters = 0;
    for (; iters < 20; iters++) {
        const a = parser.parse(src, PARSE_OPTS);
        const dead = [];
        traverse(a, {
            FunctionDeclaration(path) {
                if (!path.node.id) return;
                const b = (path.scope.parent || path.scope).getBinding(path.node.id.name);
                if (b && b.references === 0 && b.constantViolations.length === 0) dead.push(path);
            },
            VariableDeclarator(path) {
                if (!t.isIdentifier(path.node.id) || !isPureInit(path.node.init)) return;
                const b = path.scope.getBinding(path.node.id.name);
                if (b && b.references === 0 && b.constantViolations.length === 0) dead.push(path);
            },
        });
        if (!dead.length) break;
        for (const p of dead) {
            try {
                p.remove();
            } catch (e) {}
        }
        removed += dead.length;
        src = generate(a, GEN_OPTS).code;
    }
    return {
        code: src,
        removed,
        iters
    };
}


function normalizeSource(code) {
    if (/^\/\/[^\n]*distributed\.[ \t]+\S/.test(code.slice(0, 600)))
        return code.replace(/^(\/\/[^\n]*?distributed\.)[ \t]+(?=\S)/, "$1\n");
    return code;
}

function inlineObfuscatorIO(ast) {
    // 1. providers: a function whose body builds a sizable string array
    const providers = new Map();           // name -> path
    traverse(ast, {
        "FunctionDeclaration|FunctionExpression"(path) {
            const name = path.node.id ? path.node.id.name : (t.isVariableDeclarator(path.parent) ? path.parent.id.name : null);
            if (!name || providers.has(name)) return;
            let best = 0;
            path.traverse({ ArrayExpression(a) {
                const els = a.node.elements, strs = els.filter(e => t.isStringLiteral(e)).length;
                if (els.length >= 10 && strs >= els.length * 0.6 && els.length > best) best = els.length;
            }});
            if (best >= 10) providers.set(name, path);
        },
    });
    if (!providers.size) return 0;
    // 2. accessors: 1-2 param fn that calls a provider AND indexes with an offset
    const accessors = [];                  // { name, providerName, path, binding }
    traverse(ast, {
        "FunctionDeclaration|FunctionExpression"(path) {
            if (path.node.params.length < 1 || path.node.params.length > 2) return;
            const name = path.node.id ? path.node.id.name : (t.isVariableDeclarator(path.parent) ? path.parent.id.name : null);
            if (!name) return;
            let providerName = null, hasOffset = false;
            path.traverse({
                CallExpression(c) { if (t.isIdentifier(c.node.callee) && providers.has(c.node.callee.name)) providerName = c.node.callee.name; },
                BinaryExpression(b) { if (b.node.operator === "-" && t.isNumericLiteral(b.node.right)) hasOffset = true; },
                AssignmentExpression(a) { if (a.node.operator === "-=" && t.isNumericLiteral(a.node.right)) hasOffset = true; },
            });
            if (!providerName || !hasOffset) return;
            const binding = (path.scope.parent || path.scope).getBinding(name);
            if (binding) accessors.push({ name, providerName, path, binding });
        },
    });
    if (!accessors.length) return 0;
    // 3. rotators: IIFE statement referencing a provider with push + shift
    const rotators = new Map();            // providerName -> [stmt nodes]
    traverse(ast, {
        ExpressionStatement(path) {
            let prov = null, push = false, shift = false;
            path.traverse({ Identifier(i) {
                if (providers.has(i.node.name)) prov = i.node.name;
                if (i.node.name === "push") push = true;
                if (i.node.name === "shift") shift = true;
            }});
            if (prov && push && shift) { if (!rotators.has(prov)) rotators.set(prov, []); rotators.get(prov).push(path.node); }
        },
    });
    // 4. execute each accessor's trio in a sandbox -> a live decode fn
    const decl = (path, name) => t.isFunctionDeclaration(path.node) ? generate(path.node).code : ("var " + name + "=" + generate(path.node).code);
    const liveByBinding = new Map();
    for (const acc of accessors) {
        try {
            const provName = acc.providerName;
            const rots = rotators.get(provName) || [];
            if (!rots.length) continue;        // no rotator -> can't align the array. skip (avoid WRONG decodes)
            const src = decl(providers.get(provName), provName) + ";\n" +
                decl(acc.path, acc.name) + ";\n" +
                rots.map(r => generate(r).code).join("\n");
            const ctx = vm.createContext(Object.create(null));
            vm.runInContext(src, ctx, { timeout: 3000 });
            const live = vm.runInContext("typeof " + acc.name + "==='function'?" + acc.name + ":null", ctx, { timeout: 1000 });
            if (typeof live === "function") liveByBinding.set(acc.binding, live);
        } catch (e) { /* unresolvable trio -> leave its calls alone */ }
    }
    if (!liveByBinding.size) return 0;
    // 5. inline constant accessor calls -> string literals (scope-bound)
    let n = 0;
    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee, args = path.node.arguments;
            if (!t.isIdentifier(callee) || args.length < 1 || args.length > 2) return;
            const bind = path.scope.getBinding(callee.name);
            if (!bind || !liveByBinding.has(bind)) return;
            let idx = t.isNumericLiteral(args[0]) ? args[0].value
                : (t.isUnaryExpression(args[0], { operator: "-" }) && t.isNumericLiteral(args[0].argument) ? -args[0].argument.value : null);
            if (idx === null) return;
            let key;
            if (args.length === 2) { if (t.isStringLiteral(args[1])) key = args[1].value; else return; }
            let s; try { s = key === undefined ? liveByBinding.get(bind)(idx) : liveByBinding.get(bind)(idx, key); } catch (e) { return; }
            if (typeof s !== "string" || !isPrintable(s)) return;
            path.replaceWith(t.stringLiteral(s));
            n++;
        },
    });
    return n;
}

function deobfuscate(code) {
    code = normalizeSource(code);
    const ast = parser.parse(code, PARSE_OPTS);
    const accessorByBinding = buildResolvers(ast);
    console.error(`[deobf] string-table accessors bound: ${accessorByBinding.size}`);
    // Pass 3: base64 wrapper functions
    const atobBindings = new Set();
    traverse(ast, {
        VariableDeclarator(path) {
            const init = path.node.init;
            const isAtob = (t.isMemberExpression(init) && t.isIdentifier(init.property, {
                    name: "atob"
                })) ||
                (t.isIdentifier(init, {
                    name: "atob"
                }));
            if (isAtob) {
                const b = path.scope.getBinding(path.node.id.name);
                if (b) atobBindings.add(b);
            }
        },
    });
    const b64AccessorBindings = new Set();
    traverse(ast, {
        Function(path) {
            if (path.node.params.length !== 1) return;
            let calls = false;
            path.traverse({
                CallExpression(c) {
                    if (!t.isIdentifier(c.node.callee)) return;
                    const b = c.scope.getBinding(c.node.callee.name);
                    if (b && atobBindings.has(b)) calls = true;
                },
            });
            if (!calls) return;
            const name = path.node.id ? path.node.id.name : (t.isVariableDeclarator(path.parent) ? path.parent.id.name : null);
            if (!name) return;
            const b = path.scope.getBinding(name) || (path.parentPath && path.parentPath.scope.getBinding(name));
            if (b) b64AccessorBindings.add(b);
        },
    });
    console.error(`[deobf] base64 wrappers: ${b64AccessorBindings.size}`);
    // Pass 4: replace constant arg accessor calls with string literals
    let nB91 = 0,
        nB64 = 0,
        skipped = 0;
    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee;
            if (!t.isIdentifier(callee) || path.node.arguments.length !== 1) return;
            const arg = path.node.arguments[0];
            const bind = path.scope.getBinding(callee.name);
            if (!bind) return;
            if (accessorByBinding.has(bind)) {
                let idx = null;
                if (t.isNumericLiteral(arg)) idx = arg.value;
                else if (t.isUnaryExpression(arg, {
                        operator: "-"
                    }) && t.isNumericLiteral(arg.argument)) idx = -arg.argument.value;
                if (idx === null || idx < 0) {
                    skipped++;
                    return;
                }
                const s = accessorByBinding.get(bind).decoded[idx];
                if (s == null) {
                    skipped++;
                    return;
                }
                path.replaceWith(t.stringLiteral(s));
                nB91++;
                return;
            }
            if (b64AccessorBindings.has(bind) && t.isStringLiteral(arg)) {
                let dec;
                try {
                    dec = Buffer.from(arg.value, "base64").toString("latin1");
                } catch (e) {
                    return;
                }
                if (!isPrintable(dec)) return;
                path.replaceWith(t.stringLiteral(dec));
                nB64++;
            }
        },
    });
    console.error(`[deobf] replaced: ${nB91} basE91 + ${nB64} base64  (dynamic/skipped: ${skipped})`);
    // Pass 4b: obfuscator.io rotated string-arrays (PX base64 generation)
    const nObf = inlineObfuscatorIO(ast);
    console.error(`[deobf] obfuscator.io string-array calls inlined: ${nObf}`);
    // Pass 5: strip dead decoy closures "<rnd>" in <emptyObj> && (function(){…})()
    const BUILTIN_PROPS = new Set(["length", "name", "prototype", "constructor", "call", "apply", "bind",
        "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "arguments", "caller",
        "__proto__", "toLocaleString"
    ]);
    const emptyTargets = new Set();
    traverse(ast, {
        "FunctionDeclaration|FunctionExpression"(path) {
            if (path.node.body && t.isBlockStatement(path.node.body) && path.node.body.body.length === 0) {
                const name = path.node.id ? path.node.id.name : (t.isVariableDeclarator(path.parent) ? path.parent.id.name : null);
                if (name) {
                    const b = (path.scope.parent || path.scope).getBinding(name);
                    if (b) emptyTargets.add(b);
                }
            }
        },
        VariableDeclarator(path) {
            if (t.isObjectExpression(path.node.init) && path.node.init.properties.length === 0) {
                const b = path.scope.getBinding(path.node.id.name);
                if (b) emptyTargets.add(b);
            }
        },
    });
    let nDecoy = 0;
    traverse(ast, {
        LogicalExpression(path) {
            const n = path.node;
            if (n.operator !== "&&") return;
            if (!t.isBinaryExpression(n.left, {
                    operator: "in"
                })) return;
            if (!t.isStringLiteral(n.left.left) || !t.isIdentifier(n.left.right)) return;
            if (BUILTIN_PROPS.has(n.left.left.value)) return;
            const bind = path.scope.getBinding(n.left.right.name);
            if (!bind || !emptyTargets.has(bind)) return;
            const parent = path.parentPath;
            if (parent.isExpressionStatement()) {
                parent.remove();
            } else if (parent.isSequenceExpression()) {
                const rest = parent.node.expressions.filter(e => e !== n);
                parent.replaceWith(rest.length === 1 ? rest[0] : t.sequenceExpression(rest));
            } else {
                path.replaceWith(t.booleanLiteral(false));
            }
            nDecoy++;
        },
    });
    console.error(`[deobf] stripped dead decoy closures: ${nDecoy}`);
    let out = generate(ast, GEN_OPTS).code;
    // Pass 6: dead-function/var elimination
    const dce = deadCodeEliminate(out);
    out = dce.code;
    console.error(`[deobf] dead-code elimination: removed ${dce.removed} declarations over ${dce.iters} passes`);
    // report the basE91 string tables fate
    {
        const a = parser.parse(out, PARSE_OPTS);
        const tableNames = new Set();
        traverse(a, {
            AssignmentExpression(p) {
                const r = p.node.right;
                if (t.isCallExpression(r) && r.arguments.length === 1 && t.isMemberExpression(r.arguments[0]) &&
                    r.arguments[0].computed && t.isIdentifier(r.arguments[0].object)) tableNames.add(r.arguments[0].object.name);
            },
        });
        let info = "(fully removed — no dynamic calls remained)",
            best = -1;
        traverse(a, {
            VariableDeclarator(path) {
                if (t.isIdentifier(path.node.id) && tableNames.has(path.node.id.name) && t.isArrayExpression(path.node.init)) {
                    const len = path.node.init.elements.length;
                    if (len <= best) return;
                    best = len;
                    const b = path.scope.getBinding(path.node.id.name);
                    info = `${path.node.id.name}[${len}] kept — ${b ? b.references : "?"} refs (still used by the ${skipped} dynamic-index calls)`;
                }
            },
        });
        console.error(`[deobf] basE91 string table: ${info}`);
    }
    return out;
}
// STAGE 2: unflatten(code, report) -> code
// constant expression evaluator over the accumulator environment
function evalConst(node, env) {
    if (t.isNumericLiteral(node)) return node.value;
    if (t.isUnaryExpression(node) && node.operator === "-") return -evalConst(node.argument, env);
    if (t.isUnaryExpression(node) && node.operator === "+") return +evalConst(node.argument, env);
    if (t.isIdentifier(node)) {
        if (Object.prototype.hasOwnProperty.call(env, node.name)) return env[node.name];
        throw new Error("unbound " + node.name);
    }
    if (t.isBinaryExpression(node)) {
        const l = evalConst(node.left, env),
            r = evalConst(node.right, env);
        switch (node.operator) {
        case "+":
            return l + r;
        case "-":
            return l - r;
        case "*":
            return l * r;
        case "/":
            return l / r;
        case "%":
            return l % r;
        }
    }
    throw new Error("cannot evaluate " + node.type);
}

function sumOperands(node) {
    const out = [];
    (function walk(n) {
        if (t.isBinaryExpression(n, {
                operator: "+"
            })) {
            walk(n.left);
            walk(n.right);
        } else out.push(n);
    })(node);
    return out;
}

const numericArg = (a) => a && (t.isNumericLiteral(a) || (t.isUnaryExpression(a, {
    operator: "-"
}) && t.isNumericLiteral(a.argument)));

function initialEnvs(m) {
    const argIndex = {};
    let stateObjDefault = null;
    const collect = (expr) => {
        if (t.isSequenceExpression(expr)) {
            expr.expressions.forEach(collect);
            return;
        }
        if (t.isAssignmentExpression(expr) && t.isIdentifier(expr.left)) {
            const r = expr.right;
            if (t.isMemberExpression(r) && r.computed && t.isNumericLiteral(r.property)) {
                argIndex[expr.left.name] = r.property.value;
            } else if (t.isConditionalExpression(r) &&
                t.isBinaryExpression(r.test, {
                    operator: "==="
                }) &&
                t.isMemberExpression(r.test.right) && t.isNumericLiteral(r.test.right.property)) {
                stateObjDefault = r.consequent;
                argIndex[expr.left.name] = r.test.right.property.value;
            }
            collect(r);
        }
    };
    const init = m.forNode.init;
    if (t.isVariableDeclaration(init))
        for (const d of init.declarations)
            if (d.init) collect(d.init);
    const fnId = m.innerFn.node.id;
    if (!fnId) return {
        entries: [],
        stateObjDefault
    };
    const bind = m.innerFn.scope.parent ? m.innerFn.scope.parent.getBinding(fnId.name) : null;
    const entries = [],
        seen = new Set();
    if (bind)
        for (const ref of bind.referencePaths) {
            if (!(ref.parentPath && ref.parentPath.isCallExpression({
                    callee: ref.node
                }))) continue;
            const args = ref.parentPath.node.arguments;
            const env = {};
            let ok = true;
            for (const name of m.accNames) {
                const k = argIndex[name];
                if (k == null || !numericArg(args[k])) {
                    ok = false;
                    break;
                }
                env[name] = evalConst(args[k], {});
            }
            if (!ok) continue;
            const key = m.accNames.map(n => env[n]).join(",");
            if (!seen.has(key)) {
                seen.add(key);
                entries.push(env);
            }
        }
    return {
        entries,
        stateObjDefault
    };
}

function selectClause(cases, sum, env) {
    let def = -1;
    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        if (c.test === null) {
            def = i;
            continue;
        }
        let v;
        try {
            v = evalConst(c.test, env);
        } catch (e) {
            continue;
        }
        if (v === sum) return i;
    }
    return def;
}

function gatherBlock(cases, start) {
    const stmts = [];
    for (let i = start; i < cases.length; i++) {
        for (const s of cases[i].consequent) {
            if (t.isBreakStatement(s)) return {
                stmts,
                terminal: "break"
            };
            if (t.isReturnStatement(s)) {
                stmts.push(s);
                return {
                    stmts,
                    terminal: "return"
                };
            }
            stmts.push(s);
        }
    }
    return {
        stmts,
        terminal: "fallout"
    };
}
// Top-aware evaluation: a data variant accumulator beocmes TOP, propagating
const TOP = Symbol("TOP");

function evalTop(node, env) {
    if (t.isNumericLiteral(node)) return node.value;
    if (t.isUnaryExpression(node) && node.operator === "-") {
        const v = evalTop(node.argument, env);
        return v === TOP ? TOP : -v;
    }
    if (t.isUnaryExpression(node) && node.operator === "+") {
        const v = evalTop(node.argument, env);
        return v === TOP ? TOP : +v;
    }
    if (t.isIdentifier(node)) {
        if (Object.prototype.hasOwnProperty.call(env, node.name)) return env[node.name];
        return TOP;
    }
    if (t.isBinaryExpression(node)) {
        const l = evalTop(node.left, env),
            r = evalTop(node.right, env);
        if (l === TOP || r === TOP) return TOP;
        switch (node.operator) {
        case "+":
            return l + r;
        case "-":
            return l - r;
        case "*":
            return l * r;
        case "/":
            return l / r;
        case "%":
            return l % r;
        }
        return TOP;
    }
    return TOP;
}

function applyExpr(expr, env, accums) {
    const one = (a) => {
        if (!t.isAssignmentExpression(a) || !t.isIdentifier(a.left) || !accums.has(a.left.name)) return;
        const cur = env[a.left.name];
        const val = evalTop(a.right, env);
        if (a.operator === "+=") env[a.left.name] = (cur === TOP || val === TOP) ? TOP : cur + val;
        else if (a.operator === "=") env[a.left.name] = val;
        else env[a.left.name] = TOP;
    };
    if (t.isSequenceExpression(expr)) expr.expressions.forEach(one);
    else one(expr);
}

function markTop(node, env, accums) {
    (function walk(n) {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) {
            n.forEach(walk);
            return;
        }
        if (t.isAssignmentExpression(n) && t.isIdentifier(n.left) && accums.has(n.left.name)) env[n.left.name] = TOP;
        if (t.isUpdateExpression(n) && t.isIdentifier(n.argument) && accums.has(n.argument.name)) env[n.argument.name] = TOP;
        for (const k of Object.keys(n)) {
            if (k === "type" || k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments") continue;
            const v = n[k];
            if (v && typeof v === "object") walk(v);
        }
    })(node);
}

function enumerateBlock(blockStmts, entryEnv, accums) {
    const breakEnvs = [];
    function rec(list, env) {
        let frontier = [Object.assign({}, env)];
        for (const s of list) {
            const next = [];
            for (const e of frontier) {
                if (t.isBreakStatement(s)) {
                    breakEnvs.push(e);
                    continue;
                }
                if (t.isReturnStatement(s)) continue;
                if (t.isExpressionStatement(s)) {
                    applyExpr(s.expression, e, accums);
                    next.push(e);
                    continue;
                }
                if (t.isIfStatement(s)) {
                    const cons = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
                    rec(cons, e).forEach(c => next.push(c));
                    if (s.alternate) {
                        const alt = t.isBlockStatement(s.alternate) ? s.alternate.body : [s.alternate];
                        rec(alt, Object.assign({}, e)).forEach(c => next.push(c));
                    } else {
                        next.push(e);
                    }
                    continue;
                }
                markTop(s, e, accums);
                next.push(e);
                continue;
            }
            frontier = next;
            if (!frontier.length) break;
        }
        return frontier;
    }
    const fallout = rec(blockStmts, entryEnv);
    return breakEnvs.concat(fallout);
}

// linearization helpers
const numLit = (v) => (v >= 0 ? t.numericLiteral(v) : t.unaryExpression("-", t.numericLiteral(-v)));

const stateRoot = (node, ctx) => {
    let o = node;
    while (t.isMemberExpression(o)) o = o.object;
    return t.isIdentifier(o) && (o.name === ctx.holder || o.name === ctx.work || o.name === ctx.ptr);
};

const finalProp = (node) => (t.isIdentifier(node.property) ? node.property.name : (t.isStringLiteral(node.property) ? node.property.value : null));

function tx(node, ctx) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(n => tx(n, ctx));
    if (t.isMemberExpression(node) && stateRoot(node, ctx)) {
        const p = finalProp(node);
        if (p) return t.memberExpression(t.identifier("S"), t.identifier(p));
    }
    if (t.isIdentifier(node)) {
        if (ctx.accums.has(node.name)) return numLit(ctx.env[node.name]);
        if (ctx.exposed.has(node.name)) return t.memberExpression(t.identifier("S"), t.identifier(node.name));
        return node;
    }
    const out = Object.assign({}, node);
    // a non-computed property/key is a FIXED name, not a variable — never rewrite it
    // (otherwise `obj.foo` could become the invalid `obj.(S.foo)` when foo is a state name)
    const skip = (!node.computed && (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))) ? "property"
        : (!node.computed && (t.isObjectProperty(node) || t.isObjectMethod(node) || t.isClassProperty(node) || t.isClassMethod(node))) ? "key" : null;
    for (const k of Object.keys(node)) {
        if (k === skip || k === "type" || k === "loc" || k === "start" || k === "end" || k === "range" ||
            k === "leadingComments" || k === "trailingComments" || k === "innerComments" || k.startsWith("_")) continue;
        const v = node[k];
        if (v && typeof v === "object") out[k] = tx(v, ctx);
    }
    return out;
}

const isDrop = (a, ctx) => t.isAssignmentExpression(a) && (
    (t.isIdentifier(a.left) && ctx.accums.has(a.left.name)) ||
    (t.isMemberExpression(a.left) && t.isIdentifier(a.left.object, {
            name: ctx.holder
        }) &&
        t.isIdentifier(a.left.property) && (a.left.property.name === ctx.ptr || a.left.property.name === ctx.work)));

const isFlag = (a) => t.isAssignmentExpression(a) && t.isIdentifier(a.left) &&
    (t.isBooleanLiteral(a.right, {
        value: true
    }) || (t.isUnaryExpression(a.right, {
        operator: "!"
    }) && t.isNumericLiteral(a.right.argument, {
        value: 0
    })));

const asNum = (n) => t.isNumericLiteral(n) ? n.value : (t.isUnaryExpression(n, {
    operator: "-"
}) && t.isNumericLiteral(n.argument) ? -n.argument.value : null);

function fold(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(fold);
    const out = Object.assign({}, node);
    for (const k of Object.keys(node)) {
        if (k === "type" || k === "loc" || k === "start" || k === "end" || k.startsWith("_")) continue;
        const v = node[k];
        if (v && typeof v === "object") out[k] = fold(v);
    }
    if (t.isBinaryExpression(out) && ["+", "-", "*"].includes(out.operator)) {
        const l = asNum(out.left),
            r = asNum(out.right);
        if (l !== null && r !== null) return numLit(out.operator === "+" ? l + r : out.operator === "-" ? l - r : l * r);
    }
    return out;
}

function unflatten(code, REPORT) {
    const ast = parser.parse(code, PARSE_OPTS);
    const accessorByBinding = buildResolvers(ast);
    console.error(`[unflat] string-table accessors bound: ${accessorByBinding.size}`);
    // detect the flattened machines
    const machines = [];
    traverse(ast, {
        ForStatement(path) {
            const node = path.node;
            const test = node.test;
            if (!t.isBinaryExpression(test, {
                    operator: "!=="
                })) return;
            const sumNode = test.left;
            const accNames = sumOperands(sumNode).filter(n => t.isIdentifier(n)).map(n => n.name);
            if (accNames.length < 2 || sumOperands(sumNode).some(n => !t.isIdentifier(n))) return;
            let term;
            try {
                term = evalConst(test.right, {});
            } catch (e) {
                return;
            }
            let body = node.body;
            if (t.isBlockStatement(body) && body.body.length === 1) body = body.body[0];
            if (!t.isWithStatement(body)) return;
            let sw = body.body;
            if (t.isBlockStatement(sw) && sw.body.length === 1) sw = sw.body[0];
            if (!t.isSwitchStatement(sw)) return;
            const innerFn = path.getFunctionParent();
            if (!innerFn) return;
            machines.push({
                path,
                forNode: node,
                switchNode: sw,
                accNames,
                term,
                innerFn,
                withObj: body.object
            });
        },
    });
    console.error(`[unflat] flattened state machines detected: ${machines.length}`);
    // symbolically execute (constant propagation worklist to a fixpoint)
    const stmtEnvs = new Map();
    const traces = [];
    let complexCount = 0,
        ambiguousCount = 0;
    const ENV_CAP = 32;
    for (const m of machines) {
        const accums = new Set(m.accNames);
        const start = initialEnvs(m);
        const loc = m.forNode.loc ? m.forNode.loc.start.line : "?";
        if (!start.entries.length) {
            traces.push({
                loc,
                accNames: m.accNames,
                error: "no entry / call site"
            });
            continue;
        }
        const cases = m.switchNode.cases;
        const sumOf = (env) => m.accNames.reduce((a, n) => a + env[n], 0);
        const blocks = new Map();
        const order = [];
        let complex = false,
            guard = 0;
        const work = start.entries.map(env => {
            const s = sumOf(env);
            return {
                ci: selectClause(cases, s, env),
                env,
                sum: s
            };
        });
        while (work.length && guard++ < 8000) {
            const {
                ci,
                env,
                sum
            } = work.shift();
            if (ci < 0) continue;
            const prev = blocks.get(ci);
            if (prev) {
                if (prev.envs.length < ENV_CAP) {
                    if (!prev.envs.some(e => m.accNames.every(n => e[n] === env[n]))) prev.envs.push(env);
                } else prev.overflow = true;
                continue;
            }
            const {
                stmts,
                terminal
            } = gatherBlock(cases, ci);
            const snapshot = Object.assign({}, env);
            const rec = {
                envs: [snapshot],
                stmts,
                terminal,
                sum,
                overflow: false
            };
            blocks.set(ci, rec);
            order.push(ci);
            if (terminal === "return") {
                rec.succCount = 0;
                continue;
            }
            const successors = enumerateBlock(stmts, env, accums);
            rec.succCount = 0;
            for (const succ of successors) {
                if (m.accNames.some(n => succ[n] === TOP)) {
                    complex = true;
                    continue;
                }
                const nsum = sumOf(succ);
                rec.succCount++;
                if (nsum === m.term) continue;
                work.push({
                    ci: selectClause(cases, nsum, succ),
                    env: succ,
                    sum: nsum
                });
            }
        }
        let machineAmbiguous = false;
        for (const [, rec] of blocks) {
            for (const s of rec.stmts) stmtEnvs.set(s, rec);
            if (rec.envs.length > 1 || rec.overflow) machineAmbiguous = true;
        }
        if (complex) complexCount++;
        if (machineAmbiguous) ambiguousCount++;
        const returns = [...blocks.values()].some(b => b.terminal === "return");
        const straightLine = !machineAmbiguous && !complex && start.entries.length === 1 &&
            returns && [...blocks.values()].every(b => (b.succCount == null ? 0 : b.succCount) <= 1);
        traces.push({
            loc,
            m,
            blocks,
            order,
            complex,
            anyAmbiguous: machineAmbiguous,
            straightLine,
            stateObjDefault: start.stateObjDefault,
            accNames: m.accNames,
            term: m.term
        });
    }

    console.error(`[unflat] machines analysed: ${machines.length}  (data-dependent deltas: ${complexCount}, ambiguous loops: ${ambiguousCount})`);

    const machineSwitchNodes = new Set(machines.map(m => m.switchNode));

    // resolve & inline dynamic string indices
    let nResolved = 0,
        nFailed = 0;

    const resolvedSamples = [],
        failReasons = {},
        failSamples = [];

    const fail = (reason, path) => {
        nFailed++;
        failReasons[reason] = (failReasons[reason] || 0) + 1;
        if (failSamples.length < 60) {
            const line = path.node.loc ? path.node.loc.start.line : "?";
            failSamples.push(`L${line} ${reason}: ${generate(path.node).code}`);
        }
    };

    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee;
            if (!t.isIdentifier(callee) || path.node.arguments.length !== 1) return;
            const bind = path.scope.getBinding(callee.name);
            if (!bind || !accessorByBinding.has(bind)) return;
            const arg = path.node.arguments[0];
            if (t.isNumericLiteral(arg)) return;
            if (t.isUnaryExpression(arg, {
                    operator: "-"
                }) && t.isNumericLiteral(arg.argument)) return;
            let p = path,
                rec = null,
                insideMachine = false;
            while (p) {
                if (stmtEnvs.has(p.node)) {
                    rec = stmtEnvs.get(p.node);
                    break;
                }
                if (machineSwitchNodes.has(p.node)) insideMachine = true;
                p = p.parentPath;
            }
            if (!rec) {
                if (insideMachine) return fail("unreached-block", path);
                return;
            }
            if (rec.overflow) return fail("drift-overflow", path);
            let idx = null,
                top = false,
                inconsistent = false;
            for (const env of rec.envs) {
                const v = evalTop(arg, env);
                if (v === TOP) {
                    top = true;
                    break;
                }
                if (!Number.isInteger(v) || v < 0) {
                    inconsistent = true;
                    break;
                }
                if (idx === null) idx = v;
                else if (idx !== v) {
                    inconsistent = true;
                    break;
                }
            }
            if (top) return fail("data-indexed(TOP)", path);
            if (inconsistent || idx === null) return fail("inconsistent-index", path);
            const s = accessorByBinding.get(bind).decoded[idx];
            if (s == null) return fail("index-out-of-range", path);
            if (!isPrintable(s)) return fail("nonprintable", path);
            const src = generate(arg).code;
            path.replaceWith(t.stringLiteral(s));
            nResolved++;
            if (resolvedSamples.length < 40) resolvedSamples.push(`${callee.name}(${src}) -> ${JSON.stringify(s)}`);
        },
    });

    console.error(`[unflat] dynamic indices resolved & inlined: ${nResolved}  (unresolved: ${nFailed})`);
    console.error(`[unflat] unresolved breakdown: ${JSON.stringify(failReasons)}`);

    if (REPORT) {
        console.error("\n===== MACHINE TRACES =====");
        for (const tr of traces) {
            if (tr.error) {
                console.error(`L${tr.loc} [${tr.accNames.join("+")}]  ERROR: ${tr.error}`);
                continue;
            }
            const nb = tr.order.length;
            const flags = [tr.complex ? "data-dependent-deltas" : null, tr.anyAmbiguous ? "ambiguous-loop" : null].filter(Boolean).join(",");
            const ret = [...tr.blocks.values()].some(b => b.terminal === "return");
            const seq = tr.order.slice(0, 18).map(ci => `${tr.blocks.get(ci).sum}`).join(" -> ");
            console.error(`L${tr.loc} [${tr.accNames.join("+")}] term=${tr.term}  blocks=${nb}${flags ? "  (" + flags + ")" : ""}${ret ? "  -> return" : ""}`);
            console.error(`   ${seq}${nb > 18 ? " -> …" : ""}`);
        }
        console.error("\n===== RESOLVED INDEX SAMPLES =====");
        for (const r of resolvedSamples) console.error("   " + r);
        console.error("\n===== UNRESOLVED CALL SITES =====");
        for (const r of failSamples) console.error("   " + r);
    }
    // Phase 2: structural linearization of straight line machines
    let nLinearized = 0;
    const linNames = [];
    for (const tr of traces) {
        if (!tr.straightLine || !tr.m.withObj) continue;
        let wo = tr.m.withObj;
        if (t.isLogicalExpression(wo)) wo = wo.left;
        if (!t.isMemberExpression(wo) || !t.isIdentifier(wo.object) || !t.isIdentifier(wo.property)) continue;
        const holder = wo.object.name,
            ptr = wo.property.name;
        if (!tr.stateObjDefault || !t.isObjectExpression(tr.stateObjDefault) || !tr.stateObjDefault.properties.length) continue;
        const wp = tr.stateObjDefault.properties[0];
        const work = t.isIdentifier(wp.key) ? wp.key.name : (t.isStringLiteral(wp.key) ? wp.key.value : null);
        if (!work) continue;
        const accums = new Set(tr.accNames);
        const exposed = new Set();
        const ctx0 = {
            holder,
            work,
            ptr
        };
        for (const ci of tr.order)
            for (const s of tr.blocks.get(ci).stmts) {
                (function scan(n) {
                    if (!n || typeof n !== "object") return;
                    if (Array.isArray(n)) {
                        n.forEach(scan);
                        return;
                    }
                    if (t.isMemberExpression(n) && stateRoot(n, ctx0)) {
                        const p = finalProp(n);
                        if (p && p !== ptr && p !== work) exposed.add(p);
                    }
                    for (const k of Object.keys(n)) {
                        if (k === "type" || k === "loc" || k === "start" || k === "end" || k.startsWith("_")) continue;
                        const v = n[k];
                        if (v && typeof v === "object") scan(v);
                    }
                })(s);
            }
        const blockStmts = [];
        for (const ci of tr.order) {
            const rec = tr.blocks.get(ci);
            const ctx = {
                holder,
                work,
                ptr,
                accums,
                exposed,
                env: rec.envs[0]
            };
            for (const s of rec.stmts) {
                if (t.isExpressionStatement(s)) {
                    const atoms = t.isSequenceExpression(s.expression) ? s.expression.expressions : [s.expression];
                    const kept = atoms.filter(a => !isDrop(a, ctx)).map(a => fold(tx(a, ctx)));
                    if (kept.length) blockStmts.push(t.expressionStatement(kept.length === 1 ? kept[0] : t.sequenceExpression(kept)));
                } else if (t.isReturnStatement(s)) {
                    if (!s.argument) {
                        blockStmts.push(t.returnStatement(null));
                        continue;
                    }
                    const atoms = t.isSequenceExpression(s.argument) ? s.argument.expressions : [s.argument];
                    const kept = atoms.filter(a => !isFlag(a)).map(a => fold(tx(a, ctx)));
                    blockStmts.push(t.returnStatement(kept.length === 1 ? kept[0] : t.sequenceExpression(kept)));
                } else {
                    blockStmts.push(fold(tx(s, ctx)));
                }
            }
        }
        const probe = generate(t.program(blockStmts)).code;
        if (/\bswitch\b|\bwith\b/.test(probe) || tr.accNames.some(a => new RegExp("\\b" + a + "\\b").test(probe))) continue;

        const outer = tr.m.innerFn.getFunctionParent();

        if (!outer || !t.isBlockStatement(outer.node.body)) continue;

        const ob = outer.node.body.body;

        const innerName = tr.m.innerFn.node.id ? tr.m.innerFn.node.id.name : null;

        let invDecl = null,
            flagName = null;
        for (const s of ob) {
            if (!t.isVariableDeclaration(s)) continue;
            const callD = s.declarations.find(d => d.init && t.isCallExpression(d.init) && t.isIdentifier(d.init.callee, {
                name: innerName
            }));
            if (callD) {
                invDecl = s;
                const flagD = s.declarations.find(d => !d.init);
                if (flagD && t.isIdentifier(flagD.id)) flagName = flagD.id.name;
                break;
            }
        }

        const kept = ob.filter(s => s !== tr.m.innerFn.node && s !== invDecl &&
            !(flagName && t.isIfStatement(s) && t.isIdentifier(s.test, {
                name: flagName
            })));

        const declared = new Set(["S"]);

        for (const pn of outer.node.params)
            if (t.isIdentifier(pn)) declared.add(pn.name);
        if (outer.node.id) declared.add(outer.node.id.name);
        for (const s of kept) {
            if (t.isVariableDeclaration(s))
                for (const d of s.declarations) {
                    if (t.isIdentifier(d.id)) declared.add(d.id.name);
                }
            if (t.isFunctionDeclaration(s) && s.id) declared.add(s.id.name);
        }

        const temps = new Set();

        (function scan(n) {
            if (!n || typeof n !== "object") return;
            if (Array.isArray(n)) {
                n.forEach(scan);
                return;
            }
            if (t.isForStatement(n) && n.init && t.isVariableDeclaration(n.init))
                for (const d of n.init.declarations)
                    if (t.isIdentifier(d.id)) declared.add(d.id.name);
            if (t.isAssignmentExpression(n) && t.isIdentifier(n.left) && n.left.name !== "S" && !declared.has(n.left.name)) temps.add(n.left.name);
            for (const k of Object.keys(n)) {
                if (k === "type" || k === "loc" || k === "start" || k === "end" || k.startsWith("_")) continue;
                const v = n[k];
                if (v && typeof v === "object") scan(v);
            }
        })(blockStmts);

        const decls = [t.variableDeclarator(t.identifier("S"), t.objectExpression([]))];
        for (const nm of temps) decls.push(t.variableDeclarator(t.identifier(nm)));
        outer.node.body.body = [...kept, t.variableDeclaration("var", decls), ...blockStmts];
        nLinearized++;
        linNames.push(`L${tr.loc}`);
    }
    console.error(`[unflat] machines linearized to straight-line code: ${nLinearized}  [${linNames.join(", ")}]`);
    const outCode = generate(ast, GEN_OPTS).code;
    try {
        parser.parse(outCode, {
            sourceType: "script",
            errorRecovery: false,
            allowReturnOutsideFunction: true
        });
    } catch (e) {
        console.error(`[unflat] FATAL: output failed to parse (${e.message}); aborting.`);
        process.exit(1);
    }
    return outCode;
}
// main — read -> deobfuscate -> unflatten -> write
const IN = process.argv[2] || "init.js";
const OUT = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : IN.replace(/\.js$/, "") + ".clean.js";
const REPORT = process.argv.includes("--report");
console.error(`[pxclean] reading ${IN} …`);
const src = fs.readFileSync(IN, "utf8");
console.error("[pxclean] === stage 1: deobfuscate ===");
const stage1 = deobfuscate(src);
console.error("[pxclean] === stage 2: unflatten ===");
const stage2 = unflatten(stage1, REPORT);
fs.writeFileSync(OUT, stage2);
console.error(`[pxclean] wrote ${OUT}  (${(stage2.length / 1024).toFixed(0)} KB)`);
