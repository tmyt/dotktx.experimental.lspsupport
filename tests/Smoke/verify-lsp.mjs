#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { loadavg } from "node:os"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(projectDir, "Program.kt")
const sourceUri = pathToFileURL(sourcePath).href
const interopPath = join(projectDir, "ClrInterop.kt")
const interopUri = pathToFileURL(interopPath).href
const receiverPath = join(projectDir, "ReceiverLambda.kt")
const receiverUri = pathToFileURL(receiverPath).href
const receiverDocumentText = readFileSync(receiverPath, "utf8")
const suspendPath = join(projectDir, "SuspendLambda.kt")
const suspendUri = pathToFileURL(suspendPath).href
const suspendDocumentText = readFileSync(suspendPath, "utf8")
const constructorPath = join(projectDir, "SecondaryConstructors.kt")
const constructorUri = pathToFileURL(constructorPath).href
const constructorDocumentText = readFileSync(constructorPath, "utf8")
const rootUri = pathToFileURL(projectDir).href
const documentText = readFileSync(sourcePath, "utf8")
const interopDocumentText = readFileSync(interopPath, "utf8")
const analysisDocumentText = "import kotlin.clr.\n" + documentText
const ownsSystemPath = !process.env.KOTLIN_LSP_SYSTEM_PATH
const systemPath = process.env.KOTLIN_LSP_SYSTEM_PATH ??
    join(projectDir, "..", "..", "artifacts", "verification", `lsp-verifier-${process.pid}`)
const analyzerIndexDir = join(systemPath, "index")

function findServer() {
    if (process.env.KOTLIN_LSP_SERVER) return process.env.KOTLIN_LSP_SERVER

    const extensionRoots = [
        join(homedir(), ".vscode-server", "extensions"),
        join(homedir(), ".vscode", "extensions"),
    ]
    const candidates = []
    for (const root of extensionRoots) {
        if (!existsSync(root)) continue
        for (const entry of readdirSync(root)) {
            if (!entry.startsWith("jetbrains.kotlin-server-")) continue
            const server = join(root, entry, "server", "bin", "intellij-server")
            if (existsSync(server)) candidates.push({ entry, server })
        }
    }
    candidates.sort((a, b) => a.entry.localeCompare(b.entry, "en", { numeric: true }))
    return candidates.at(-1)?.server
}

const serverPath = findServer()
if (!serverPath) {
    throw new Error(
        "Kotlin by JetBrains is not installed. Install VS Code extension " +
        "JetBrains.kotlin-server or set KOTLIN_LSP_SERVER."
    )
}

const child = spawn(serverPath, [
    "--stdio",
    "--system-path", systemPath,
    "--log-level", "WARNING",
], {
    cwd: projectDir,
    stdio: ["pipe", "pipe", "pipe"],
})

child.stderr.setEncoding("utf8")
child.stderr.on("data", chunk => process.stderr.write(chunk))

let nextId = 1
const pending = new Map()
let incoming = Buffer.alloc(0)
let receiverDiagnostics = []

function send(message) {
    const json = JSON.stringify(message)
    const body = Buffer.from(json, "utf8")
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    child.stdin.write(body)
}

function notify(method, params = {}) {
    send({ jsonrpc: "2.0", method, params })
}

function request(method, params, timeoutMs = 180_000) {
    const id = nextId++
    send({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
            pending.delete(id)
            rejectPromise(new Error(`${method} timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        pending.set(id, {
            resolve: result => {
                clearTimeout(timer)
                resolvePromise(result)
            },
            reject: error => {
                clearTimeout(timer)
                rejectPromise(error)
            },
        })
    })
}

function reply(id, result) {
    send({ jsonrpc: "2.0", id, result })
}

function handle(message) {
    if (message.method === "textDocument/publishDiagnostics" && message.params?.uri === receiverUri) {
        receiverDiagnostics = message.params.diagnostics ?? []
        return
    }
    if (Object.hasOwn(message, "id") && !message.method) {
        const waiter = pending.get(message.id)
        if (!waiter) return
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
        else waiter.resolve(message.result)
        return
    }

    if (Object.hasOwn(message, "id") && message.method) {
        switch (message.method) {
            case "workspace/configuration":
                reply(message.id, (message.params?.items ?? []).map(() => null))
                break
            case "workspace/workspaceFolders":
                reply(message.id, [{ uri: rootUri, name: "DotKtX.Experimental.LspSupport.Smoke" }])
                break
            case "window/workDoneProgress/create":
            case "client/registerCapability":
            case "client/unregisterCapability":
            case "workspace/diagnostic/refresh":
            case "workspace/inlayHint/refresh":
            case "workspace/semanticTokens/refresh":
                reply(message.id, null)
                break
            case "window/showMessageRequest":
                reply(message.id, null)
                break
            default:
                reply(message.id, null)
                break
        }
    }
}

child.stdout.on("data", chunk => {
    incoming = Buffer.concat([incoming, chunk])
    while (true) {
        const headerEnd = incoming.indexOf("\r\n\r\n")
        if (headerEnd < 0) return
        const header = incoming.subarray(0, headerEnd).toString("ascii")
        const match = /Content-Length:\s*(\d+)/i.exec(header)
        if (!match) throw new Error(`Invalid LSP header: ${header}`)
        const length = Number(match[1])
        const bodyStart = headerEnd + 4
        if (incoming.length < bodyStart + length) return
        const body = incoming.subarray(bodyStart, bodyStart + length).toString("utf8")
        incoming = incoming.subarray(bodyStart + length)
        handle(JSON.parse(body))
    }
})

let terminationRequested = false
const childExit = new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise)
    child.once("exit", (code, signal) => {
        if (code === 0 || (terminationRequested && (code === 143 || signal === "SIGTERM"))) resolvePromise()
        else rejectPromise(new Error(`Kotlin LSP exited: code=${code}, signal=${signal}`))
    })
})

function completionLabels(result) {
    const items = Array.isArray(result) ? result : result?.items ?? []
    return items.map(item => item.label)
}

function hoverText(result) {
    const contents = result?.contents
    if (typeof contents === "string") return contents
    if (Array.isArray(contents)) return contents.map(item =>
        typeof item === "string" ? item : item?.value ?? ""
    ).join("\n")
    return contents?.value ?? ""
}

async function errorDiagnostics(uri) {
    const report = await request("textDocument/diagnostic", {
        textDocument: { uri },
    })
    if (report?.kind !== "full" || !Array.isArray(report.items)) {
        throw new Error(`Expected a full diagnostic report for ${uri}: ${JSON.stringify(report)}`)
    }
    return report.items.filter(diagnostic => diagnostic.severity === 1)
}

function klibDefinition(result, symbol) {
    const locations = Array.isArray(result) ? result : result ? [result] : []
    const uris = locations.map(location => location.targetUri ?? location.uri)
    const uri = uris.find(uri => uri?.includes(".klib!/default/linkdata/"))
    if (!uri) throw new Error(`Expected a KLIB definition for ${symbol}: ${uris.join(", ")}`)
    return uri
}

async function waitForErrors(uri, matches) {
    const deadline = Date.now() + 5000
    let errors
    do {
        errors = await errorDiagnostics(uri)
        if (matches(errors)) return errors
        await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    return errors
}

function positionAfter(text, needle) {
    const index = text.indexOf(needle)
    if (index < 0) throw new Error(`Probe text was not found: ${needle}`)
    const end = index + needle.length
    const prefix = text.slice(0, end)
    const lines = prefix.split("\n")
    return { line: lines.length - 1, character: lines.at(-1).length }
}

async function waitForCompletion(position, expected, uri = sourceUri) {
    const deadline = Date.now() + 180_000
    let labels = []
    while (Date.now() < deadline) {
        try {
            const result = await request("textDocument/completion", {
                textDocument: { uri },
                position,
                context: { triggerKind: 1 },
            })
            labels = completionLabels(result)
            if (labels.includes(expected)) return labels
        } catch (error) {
            // Initial indexing can cancel editor requests. Retry until the workspace is ready.
            if (!String(error).includes("RequestCancelled") && !String(error).includes("-32800")) throw error
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
    }
    throw new Error(
        `Completion '${expected}' was not returned at ${JSON.stringify(position)}. ` +
        `Last labels: ${labels.slice(0, 30).join(", ")}`
    )
}

// Cold-index time is the number that decides whether this model is usable, and it is meaningless
// without the load it was taken under: on a busy machine the same run varies by a factor of two.
const startedAt = Date.now()
const loadAtStart = loadavg()[0]

try {
    const initializeResult = await request("initialize", {
        processId: process.pid,
        clientInfo: { name: "DotKtX.Experimental.LspSupport verifier", version: "1" },
        rootPath: projectDir,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "DotKtX.Experimental.LspSupport.Smoke" }],
        initializationOptions: {
            defaultSdk: null,
            buildTools: { [rootUri]: "json" },
            indexDir: analyzerIndexDir,
        },
        capabilities: {
            workspace: {
                configuration: true,
                workspaceFolders: true,
            },
            window: { workDoneProgress: true },
            textDocument: {
                synchronization: { didSave: true },
                completion: {
                    completionItem: {
                        snippetSupport: false,
                        documentationFormat: ["markdown", "plaintext"],
                    },
                },
                definition: { linkSupport: true },
                hover: { contentFormat: ["markdown", "plaintext"] },
            },
        },
        workDoneToken: "dotkt-lsp-support-import",
    })
    if (!initializeResult?.capabilities?.completionProvider) {
        throw new Error("Kotlin LSP did not advertise completion support")
    }

    notify("initialized")
    notify("textDocument/didOpen", {
        textDocument: {
            uri: sourceUri,
            languageId: "kotlin",
            version: 1,
            text: analysisDocumentText,
        },
    })
    notify("textDocument/didOpen", {
        textDocument: {
            uri: interopUri,
            languageId: "kotlin",
            version: 1,
            text: interopDocumentText,
        },
    })
    notify("textDocument/didOpen", {
        textDocument: {
            uri: receiverUri,
            languageId: "kotlin",
            version: 1,
            text: receiverDocumentText,
        },
    })
    notify("textDocument/didOpen", {
        textDocument: {
            uri: suspendUri,
            languageId: "kotlin",
            version: 1,
            text: suspendDocumentText,
        },
    })
    notify("textDocument/didOpen", {
        textDocument: {
            uri: constructorUri,
            languageId: "kotlin",
            version: 1,
            text: constructorDocumentText,
        },
    })

    const overlayLabels = await waitForCompletion(
        { line: 0, character: "import kotlin.clr.".length },
        "ClrRef",
    )
    for (const expected of [
        "ClrEvent", "ClrRef", "EventSubscription", "Span", "StackBuffer",
        "byref", "clrEvent", "stackBuffer",
    ]) {
        if (!overlayLabels.includes(expected)) {
            throw new Error(`DotKt standard library completion did not contain '${expected}'`)
        }
    }
    const importLabels = await waitForCompletion(
        { line: 1, character: "import System.Text.".length },
        "StringBuilder",
    )
    for (const expected of ["Encoding", "Rune", "StringBuilder", "UTF8Encoding"]) {
        if (!importLabels.includes(expected)) {
            throw new Error(`CLR import completion did not contain '${expected}'`)
        }
    }
    const memberLabels = await waitForCompletion(
        { line: 5, character: "    builder.".length },
        "Append",
    )
    for (const expected of ["Append", "Length", "ToString"]) {
        if (!memberLabels.includes(expected)) {
            throw new Error(`Member completion did not contain '${expected}'`)
        }
    }
    const definitions = await request("textDocument/definition", {
        textDocument: { uri: sourceUri },
        position: { line: 1, character: "import System.Text.Stri".length },
    })
    const builderDefinition = klibDefinition(definitions, "StringBuilder")
    const decompile = initializeResult.capabilities.executeCommandProvider?.commands
        .find(command => command.endsWith("decompile"))
    if (!decompile) throw new Error("Kotlin LSP did not advertise its decompile command")
    const decompiled = await request("workspace/executeCommand", {
        command: decompile, arguments: [builderDefinition],
    })
    if (decompiled?.language !== "kotlin" || !/\bclass StringBuilder\b/.test(decompiled.code ?? "")) {
        throw new Error(`Kotlin LSP could not open the CLR KLIB definition: ${builderDefinition}`)
    }

    const hover = await request("textDocument/hover", {
        textDocument: { uri: sourceUri },
        position: { line: 7, character: "    return builder.ToStr".length },
    })
    const renderedHover = hoverText(hover)
    if (!/ToString\(\): String(?!\?)/.test(renderedHover)) {
        throw new Error(`ToString hover did not expose the declared Kotlin return type: ${renderedHover}`)
    }

    const encodingLabels = await waitForCompletion(
        positionAfter(interopDocumentText, "Encoding."),
        "UTF8",
        interopUri,
    )
    for (const expected of ["GetEncoding", "UTF8"]) {
        if (!encodingLabels.includes(expected)) {
            throw new Error(`Encoding static completion did not contain '${expected}'`)
        }
    }
    const encodingDefinitions = await request("textDocument/definition", {
        textDocument: { uri: interopUri },
        position: {
            line: 0,
            character: "import System.Text.Enco".length,
        },
    })
    klibDefinition(encodingDefinitions, "Encoding")

    const runeLabels = await waitForCompletion(
        positionAfter(interopDocumentText, "Rune(value)."),
        "Value",
        interopUri,
    )
    for (const expected of ["ToString", "Value"]) {
        if (!runeLabels.includes(expected)) {
            throw new Error(`Rune member completion did not contain '${expected}'`)
        }
    }
    const utf8EncodingLabels = await waitForCompletion(
        positionAfter(interopDocumentText, "UTF8Encoding()."),
        "WebName",
        interopUri,
    )
    if (!utf8EncodingLabels.includes("WebName")) {
        throw new Error("UTF8Encoding completion did not inherit Encoding.WebName")
    }
    const enumLabels = await waitForCompletion(
        positionAfter(interopDocumentText, "day == DayOfWeek."),
        "Saturday",
        interopUri,
    )
    for (const expected of ["Saturday", "Sunday", "Monday"]) {
        if (!enumLabels.includes(expected)) {
            throw new Error(`CLR enum completion did not contain '${expected}'`)
        }
    }
    const genericHover = await request("textDocument/hover", {
        textDocument: { uri: interopUri },
        position: positionAfter(interopDocumentText, "builder.AppendJ"),
    })
    const renderedGenericHover = hoverText(genericHover)
    if (!renderedGenericHover.includes("<T") || !renderedGenericHover.includes("IEnumerable<T")) {
        throw new Error(`AppendJoin hover lost its generic signature: ${renderedGenericHover}`)
    }
    const interfaceDefinitions = await request("textDocument/definition", {
        textDocument: { uri: interopUri },
        position: positionAfter(interopDocumentText, "System.IClone"),
    })
    klibDefinition(interfaceDefinitions, "ICloneable")

    const interopErrors = await errorDiagnostics(interopUri)
    if (interopErrors.length !== 0) {
        throw new Error(`CLR interop diagnostics: ${JSON.stringify(interopErrors)}`)
    }
    const constructorErrors = await errorDiagnostics(constructorUri)
    if (constructorErrors.length !== 0) {
        throw new Error(`Secondary constructor diagnostics: ${JSON.stringify(constructorErrors)}`)
    }
    console.log("Kotlin LSP secondary constructors: overloads, default/named arguments, no primary, generic inference")
    const receiverErrors = await errorDiagnostics(receiverUri)
    if (receiverErrors.length !== 0) {
        throw new Error(`Receiver lambda diagnostics: ${JSON.stringify(receiverErrors)}`)
    }
    for (const needle of [
        'configure = { Font',
        'configure = { this.Font',
        'ordinary { it.Font',
        'nested(listOf({ Font',
        'nullable { Font',
    ]) {
        const completion = await request("textDocument/completion", {
            textDocument: { uri: receiverUri },
            position: positionAfter(receiverDocumentText, needle),
            context: { triggerKind: 1 },
        })
        if (!completionLabels(completion).includes("FontSize")) {
            throw new Error(`Lambda completion did not resolve FontSize at ${needle}; labels=${completionLabels(completion).slice(0, 20).join(", ")}; diagnostics=${JSON.stringify(receiverDiagnostics)}`)
        }
    }
    const receiverScope = completionLabels(await request("textDocument/completion", {
        textDocument: { uri: receiverUri },
        position: positionAfter(receiverDocumentText, 'configure = { '),
        context: { triggerKind: 1 },
    }))
    if (receiverScope.includes("it")) {
        throw new Error("A receiver-only lambda incorrectly introduced an implicit it parameter")
    }
    console.log("Kotlin LSP receiver lambda: implicit receiver, this, ordinary it, nested and nullable receivers; callback invocation and Task.Delay(Int)")

    const suspendErrors = await errorDiagnostics(suspendUri)
    if (suspendErrors.length !== 0) {
        throw new Error(`Suspend lambda diagnostics: ${JSON.stringify(suspendErrors)}`)
    }
    for (const [needle, expected] of [
        ['flow { emi', 'emit'],
        ['withContext { delay(3L); mar', 'marker'],
        ['nullableSuspend { delay(6L); mar', 'marker'],
    ]) {
        const completion = await request("textDocument/completion", {
            textDocument: { uri: suspendUri },
            position: positionAfter(suspendDocumentText, needle),
            context: { triggerKind: 1 },
        })
        if (!completionLabels(completion).includes(expected)) {
            throw new Error(`Suspend lambda completion did not resolve ${expected} at ${needle}`)
        }
    }
    const inferredHover = hoverText(await request("textDocument/hover", {
        textDocument: { uri: suspendUri },
        position: positionAfter(suspendDocumentText, 'val typed: Int = infer'),
    }))
    if (!/inferred:\s*Int\b/.test(inferredHover)) {
        throw new Error(`withContext did not infer Int: ${inferredHover}`)
    }
    // A normal callback must still reject suspend calls. This prevents a "fix" that simply
    // grants coroutine context to every lambda or suppresses the diagnostic altogether.
    notify("textDocument/didChange", {
        textDocument: { uri: suspendUri, version: 2 },
        contentChanges: [{ text: suspendDocumentText +
            '\nfun notSuspendProbe() { receiverfixture.ordinary { delay(7L) } }\n' }],
    })
    const negativeErrors = await waitForErrors(suspendUri, errors =>
        errors.some(error => error.code === "ILLEGAL_SUSPEND_FUNCTION_CALL"))
    if (negativeErrors.length !== 1 || negativeErrors[0].code !== "ILLEGAL_SUSPEND_FUNCTION_CALL") {
        throw new Error(`Ordinary callback did not reject a suspend call: ${JSON.stringify(negativeErrors)}`)
    }
    notify("textDocument/didChange", {
        textDocument: { uri: suspendUri, version: 3 },
        contentChanges: [{ text: suspendDocumentText }],
    })
    console.log("Kotlin LSP suspend lambdas: flow/emit, launch/delay, withContext inference, plain/nested/nullable callbacks, no error diagnostics")
    console.log("Kotlin LSP negative control: ordinary callback still reports ILLEGAL_SUSPEND_FUNCTION_CALL")

    notify("textDocument/didChange", {
        textDocument: { uri: interopUri, version: 2 },
        contentChanges: [{ text: interopDocumentText + [
            "",
            "fun jsOnly() = kotlin.js.Date(0)",
            "fun jvmOnly() = java.time.Instant.EPOCH",
            "fun unsupported(value: dynamic) = value.absentMember()",
        ].join("\n") + "\n" }],
    })
    const expectedErrors = new Map([
        [1, "UNRESOLVED_REFERENCE"],
        [2, "UNRESOLVED_REFERENCE"],
        [3, "UNSUPPORTED"],
    ])
    const lastLine = interopDocumentText.split("\n").length - 1
    const rejectsPlatformApis = errors => [...expectedErrors].every(([offset, code]) =>
        errors.some(error => error.range.start.line === lastLine + offset && error.code === code))
    const platformErrors = await waitForErrors(interopUri, rejectsPlatformApis)
    if (!rejectsPlatformApis(platformErrors)) {
        throw new Error(`Common model accepted a JVM/JS API or JS dynamic type: ${JSON.stringify(platformErrors)}`)
    }
    console.log("Kotlin LSP platform controls: rejects JS Date, JVM Instant and dynamic")

    console.log("Kotlin LSP DotKt standard library completion: ClrEvent, ClrRef, EventSubscription, Span, StackBuffer, byref, clrEvent, stackBuffer")
    console.log("Kotlin LSP import completion: StringBuilder")
    console.log("Kotlin LSP member completion: Append, Length, ToString")
    console.log("Kotlin LSP multi-class completion: Encoding.GetEncoding, Encoding.UTF8, Rune.ToString, Rune.Value")
    console.log("Kotlin LSP CLR inheritance completion: UTF8Encoding.WebName")
    console.log("Kotlin LSP CLR enum completion: DayOfWeek.Monday, DayOfWeek.Saturday, DayOfWeek.Sunday")
    console.log("Kotlin LSP CLR generic hover: AppendJoin<T>(..., IEnumerable<T>)")
    console.log("Kotlin LSP CLR interface definition: System.ICloneable")
    console.log(`Kotlin LSP definition and decompilation: ${builderDefinition}`)
    console.log("Kotlin LSP metadata hover: ToString(): String")

    const elapsed = (Date.now() - startedAt) / 1000
    console.log(
        `Kotlin LSP cold index and all assertions: ${elapsed.toFixed(1)}s ` +
        `(1-minute load average ${loadAtStart.toFixed(1)} at start, ${loadavg()[0].toFixed(1)} at end; ` +
        `a figure taken above ~1.0 is not comparable)`
    )

    await request("shutdown", null, 30_000)
    notify("exit")
    const exitedAfterNotification = await Promise.race([
        childExit.then(() => true),
        new Promise(resolvePromise => setTimeout(() => resolvePromise(false), 5_000)),
    ])
    // Recent standalone servers can leave the native launcher alive after the LSP endpoint has
    // acknowledged shutdown and received exit. The assertions are complete at that point; do not
    // leave CI waiting on a wrapper process indefinitely.
    if (!exitedAfterNotification) {
        terminationRequested = true
        child.kill("SIGTERM")
        await childExit
    }
} catch (error) {
    terminationRequested = true
    child.kill("SIGTERM")
    await childExit.catch(() => {})
    throw error
} finally {
    if (ownsSystemPath) rmSync(systemPath, { recursive: true, force: true })
}
