import { brainServerConfig, CLIENT_IDS, LEGACY_ANTIGRAVITY_SERVER_CONFIG, renderTomlServer, MARKER_END, MARKER_START, TOML_MARKER_END, TOML_MARKER_START, } from './config.js';
import { CliConfigurationError } from './cli-contracts.js';
const MARKDOWN_START_PREFIX = '<!-- brainmcp:managed:start';
const TOML_START_PREFIX = '# brainmcp:managed:start';
const MARKDOWN_START_PATTERN = /^<!-- brainmcp:managed:start[^\r\n]*-->$/gm;
const TOML_START_PATTERN = /^# brainmcp:managed:start[^\r\n]*$/gm;
export function hasManagedBlock(text, format) {
    return managedStarts(text, format).length > 0;
}
export function assertNoConflictingManagedBlock(text, format) {
    const [start, end] = format === 'toml' ? [TOML_MARKER_START, TOML_MARKER_END] : [MARKER_START, MARKER_END];
    const prefix = format === 'toml' ? TOML_START_PREFIX : MARKDOWN_START_PREFIX;
    const starts = managedStarts(text, format);
    const rawStartCount = text.split(prefix).length - 1;
    const endCount = text.split(end).length - 1;
    const actualStart = starts[0];
    const validSingleBlock = rawStartCount === 1 &&
        starts.length === 1 &&
        endCount === 1 &&
        actualStart !== undefined &&
        text.indexOf(end) > text.indexOf(actualStart);
    if ((rawStartCount !== 0 || endCount !== 0) && !validSingleBlock) {
        throw new CliConfigurationError(`Refusing to modify conflicting manual BrainMCP markers. Repair ${start} / ${end} first.`);
    }
}
export function upsertMarkdownBlock(existing, block) {
    const current = existing ?? '';
    assertNoConflictingManagedBlock(current, 'markdown');
    const existingStart = managedStarts(current, 'markdown')[0];
    if (existingStart) {
        return current.replace(new RegExp(`${escapeRegex(existingStart)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n?`), block);
    }
    return `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${block}`;
}
export function removeMarkdownBlock(existing) {
    if (existing === undefined)
        return undefined;
    assertNoConflictingManagedBlock(existing, 'markdown');
    const existingStart = managedStarts(existing, 'markdown')[0];
    if (!existingStart)
        return existing;
    const result = existing.replace(new RegExp(`\\n?${escapeRegex(existingStart)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n?`), '').replace(/\n{3,}/g, '\n\n');
    return result.trim() ? result : undefined;
}
export function upsertTomlBlock(existing, client) {
    const current = existing ?? '';
    assertNoConflictingManagedBlock(current, 'toml');
    const block = renderTomlServer(client);
    const existingStart = managedStarts(current, 'toml')[0];
    if (existingStart) {
        return current.replace(new RegExp(`${escapeRegex(existingStart)}[\\s\\S]*?${escapeRegex(TOML_MARKER_END)}\\n?`), block);
    }
    return replaceTomlBrainTables(current, block);
}
export function removeTomlBlock(existing) {
    if (existing === undefined)
        return undefined;
    assertNoConflictingManagedBlock(existing, 'toml');
    const existingStart = managedStarts(existing, 'toml')[0];
    if (!existingStart)
        return existing;
    // CRLF line breaks go whole: a bare `\r` left behind is invalid TOML.
    const result = existing
        .replace(new RegExp(`(?:\\r?\\n)?${escapeRegex(existingStart)}[\\s\\S]*?${escapeRegex(TOML_MARKER_END)}(?:\\r?\\n)?`), '')
        .replace(/(\r?\n){3,}/g, '$1$1');
    return result.trim() ? result : undefined;
}
function managedStarts(text, format) {
    const pattern = format === 'toml' ? TOML_START_PATTERN : MARKDOWN_START_PATTERN;
    pattern.lastIndex = 0;
    return Array.from(text.matchAll(pattern), (match) => match[0]);
}
export function upsertJsonServer(existing, client, rootKey = 'mcpServers', scope = 'project') {
    const source = existing?.trim() ? existing : `{\n  "${rootKey}": {}\n}\n`;
    const desired = brainServerConfig(client, scope);
    const parsed = parseJsonc(source);
    const servers = parsed[rootKey];
    if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
        throw new Error(`${rootKey} must be an object.`);
    }
    const root = rootObjectOpen(source);
    const serverMap = servers !== undefined
        ? findObjectPropertyObject(source, root, rootKey)
        : undefined;
    if (servers !== undefined && !serverMap)
        throw new Error(`Could not locate the ${rootKey} object.`);
    const existingBrain = servers?.brain;
    if (existingBrain !== undefined) {
        if (!serverMap)
            throw new Error(`Could not locate the ${rootKey} object.`);
        const property = findObjectProperty(source, serverMap.valueOpen, 'brain');
        if (!property)
            throw new Error('Could not locate the brain MCP server entry.');
        if (sameJsonValue(existingBrain, desired))
            return existing ?? source;
        return replaceJsonPropertyValue(source, property, desired);
    }
    if (servers !== undefined)
        return insertJsonServer(source, desired, rootKey);
    return insertJsonRootMap(source, rootKey, { brain: desired });
}
export function removeJsonServer(existing, rootKey = 'mcpServers') {
    // A blank file holds no server entry; leave it as it is.
    if (existing === undefined || !existing.trim())
        return existing;
    const parsed = parseJsonc(existing);
    const parsedServers = parsed[rootKey];
    if (!parsedServers || typeof parsedServers !== 'object' || Array.isArray(parsedServers))
        return existing;
    const servers = { ...parsedServers };
    if (!isBrainConfig(servers.brain)) {
        if (servers.brain !== undefined)
            throw new CliConfigurationError('Refusing to remove a manually-managed "brain" MCP server entry.');
        return existing;
    }
    delete servers.brain;
    const next = { ...parsed, [rootKey]: servers };
    if (Object.keys(next).length === 1 && Object.keys(servers).length === 0)
        return undefined;
    const root = rootObjectOpen(existing);
    const serverMap = findObjectPropertyObject(existing, root, rootKey);
    if (!serverMap)
        throw new Error(`Could not locate the ${rootKey} object.`);
    return removeObjectProperty(existing, serverMap.valueOpen, 'brain');
}
export function parseJsonc(source) {
    try {
        const parsed = JSON.parse(removeTrailingCommas(stripJsonComments(source)));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('the root value must be an object');
        }
        return parsed;
    }
    catch (error) {
        // V8's SyntaxError quotes the input, and agent configs can hold MCP bearer tokens.
        const detail = error instanceof SyntaxError
            ? 'the file is not valid JSON/JSONC'
            : error instanceof Error ? error.message : String(error);
        throw new CliConfigurationError(`Invalid JSON/JSONC configuration: ${detail}`);
    }
}
/**
 * Update one JSONC property without reserializing the rest of the document.
 * This is used for hook files so comments and unrelated host configuration
 * survive BrainMCP install/remove operations.
 */
export function upsertJsoncPath(existing, path, value) {
    if (path.length === 0)
        throw new Error('A JSONC property path is required.');
    let source = existing?.trim() ? existing : '{}\n';
    parseJsonc(source);
    let objectOpen = rootObjectOpen(source);
    for (const segment of path.slice(0, -1)) {
        const object = findObjectPropertyObject(source, objectOpen, segment);
        if (!object) {
            source = insertJsonObjectProperty(source, objectOpen, segment, {});
            objectOpen = findObjectPropertyObject(source, objectOpen, segment).valueOpen;
            continue;
        }
        objectOpen = object.valueOpen;
    }
    const propertyName = path.at(-1);
    const property = findObjectProperty(source, objectOpen, propertyName);
    if (property) {
        const parsed = parseJsonc(source);
        let current = parsed;
        for (const segment of path) {
            current = current && typeof current === 'object' && !Array.isArray(current)
                ? current[segment]
                : undefined;
        }
        if (sameJsonValue(current, value))
            return existing ?? source;
        return replaceJsonPropertyValue(source, property, value);
    }
    return insertJsonObjectProperty(source, objectOpen, propertyName, value);
}
export function removeJsoncPath(existing, path) {
    if (existing === undefined)
        return undefined;
    if (path.length === 0)
        throw new Error('A JSONC property path is required.');
    if (!existing.trim())
        return existing;
    parseJsonc(existing);
    let objectOpen = rootObjectOpen(existing);
    for (const segment of path.slice(0, -1)) {
        const object = findObjectPropertyObject(existing, objectOpen, segment);
        if (!object)
            return existing;
        objectOpen = object.valueOpen;
    }
    return removeObjectProperty(existing, objectOpen, path.at(-1));
}
function isBrainConfig(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    return (CLIENT_IDS.some((client) => sameJsonValue(value, brainServerConfig(client, 'project')) ||
        sameJsonValue(value, brainServerConfig(client, 'user'))) ||
        sameJsonValue(value, LEGACY_ANTIGRAVITY_SERVER_CONFIG));
}
function sameJsonValue(left, right) {
    if (left === right)
        return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return (Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => sameJsonValue(value, right[index])));
    }
    if (typeof left !== 'object' || left === null ||
        typeof right !== 'object' || right === null)
        return false;
    const leftRecord = left;
    const rightRecord = right;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length &&
        leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]));
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Re-running init owns the reserved Codex table name and restores its canonical
 * value, even when old markers were removed. Unrelated TOML tables stay intact.
 */
function replaceTomlBrainTables(current, block) {
    const ranges = splitTomlSections(current).filter((section) => section.name === 'mcp_servers.brain' || section.name.startsWith('mcp_servers.brain.'));
    const mergedRanges = ranges.reduce((merged, range) => {
        const previous = merged.at(-1);
        const contentEnd = tomlSectionContentEnd(current, range);
        if (previous && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
            previous.contentEnd = contentEnd;
        }
        else {
            merged.push({ start: range.start, end: range.end, contentEnd });
        }
        return merged;
    }, []);
    let repaired = current;
    // Comment and blank lines that lead into the next, unrelated header belong to it.
    for (const range of mergedRanges.reverse()) {
        repaired = `${repaired.slice(0, range.start)}${repaired.slice(range.contentEnd)}`;
    }
    repaired = repaired.replace(/\n{3,}/g, '\n\n').trimEnd();
    return `${repaired}${repaired ? '\n\n' : ''}${block}`;
}
/**
 * Where a section's own lines end: before the first comment in its trailing
 * run of comment and blank lines, which leads into the next header. The header
 * line itself always counts as the section's.
 */
function tomlSectionContentEnd(current, section) {
    const lines = current.slice(section.start, section.end).split(/(?<=\n)/);
    let end = section.end;
    let contentEnd = section.end;
    for (let index = lines.length - 1; index > 0 && /^[\t ]*(?:#.*)?\r?\n?$/.test(lines[index]); index -= 1) {
        end -= lines[index].length;
        if (lines[index].trimStart().startsWith('#'))
            contentEnd = end;
    }
    return contentEnd;
}
/** Adds a server without reformatting existing JSONC comments or sibling entries. */
function insertJsonServer(source, server, rootKey) {
    const root = rootObjectOpen(source);
    const property = findObjectPropertyObject(source, root, rootKey);
    if (!property)
        throw new Error(`Could not locate the ${rootKey} object.`);
    const { valueOpen: open, valueClose: close } = property;
    const inner = source.slice(open + 1, close);
    const baseIndent = lineIndentAt(source, property.keyStart);
    const entryIndent = `${baseIndent}  `;
    const rendered = `"brain": ${JSON.stringify(server, null, 2).replace(/\n/g, `\n${entryIndent}`)}`;
    if (!inner.trim())
        return `${source.slice(0, open + 1)}\n${entryIndent}${rendered}\n${baseIndent}${source.slice(close)}`;
    return appendObjectEntry(source, open, close, entryIndent, rendered);
}
/**
 * Appends `rendered` after the last entry of an object that is not blank. The
 * separating comma goes right after the last value, so a trailing `// comment`
 * keeps its place instead of swallowing the comma; the entry itself starts on a
 * new line after that comment.
 */
function appendObjectEntry(source, open, close, entryIndent, rendered) {
    const contentEnd = open + 1 + source.slice(open + 1, close).search(/\s*$/);
    const valueEnd = lastTokenEnd(source, open, close);
    // An object holding only comments has no value to separate from.
    const commaAt = valueEnd < 0 ? contentEnd : valueEnd;
    const comma = valueEnd < 0 || source[valueEnd - 1] === ',' ? '' : ',';
    return `${source.slice(0, commaAt)}${comma}${source.slice(commaAt, contentEnd)}\n${entryIndent}${rendered}${source.slice(contentEnd)}`;
}
/** The offset just past an object's last value token or comma, skipping comments; -1 when it holds none. */
function lastTokenEnd(source, open, close) {
    let end = -1;
    let index = skipJsoncTrivia(source, open + 1, close);
    while (index < close) {
        const character = source[index];
        index = character === '"'
            ? jsonStringEnd(source, index) + 1
            : character === '{'
                ? matchingBrace(source, index) + 1
                : character === '[' ? matchingBracket(source, index) + 1 : index + 1;
        end = index;
        index = skipJsoncTrivia(source, index, close);
    }
    return end;
}
/** Adds a missing top-level server map without reformatting unrelated app state or JSONC comments. */
function insertJsonRootMap(source, rootKey, value) {
    const open = rootObjectOpen(source);
    const close = matchingBrace(source, open);
    const inner = source.slice(open + 1, close);
    const firstEntry = skipJsoncTrivia(source, open + 1, close);
    const entryIndent = firstEntry < close && source[firstEntry] === '"'
        ? lineIndentAt(source, firstEntry) || '  '
        : `${lineIndentAt(source, open)}  `;
    const rendered = `"${rootKey}": ${JSON.stringify(value, null, 2).replace(/\n/g, `\n${entryIndent}`)}`;
    if (!inner.trim()) {
        return `${source.slice(0, open + 1)}\n${entryIndent}${rendered}\n${source.slice(close)}`;
    }
    return appendObjectEntry(source, open, close, entryIndent, rendered);
}
/** Finds any JSON-valued property at the current object's top level. */
function findObjectProperty(source, objectOpen, propertyName) {
    const objectClose = matchingBrace(source, objectOpen);
    let found;
    let index = objectOpen + 1;
    while (index < objectClose) {
        index = skipJsoncTrivia(source, index, objectClose);
        if (index >= objectClose)
            return found;
        if (source[index] === ',') {
            index += 1;
            continue;
        }
        if (source[index] !== '"')
            throw new Error('Invalid JSON/JSONC object property.');
        const keyStart = index;
        const keyEnd = jsonStringEnd(source, keyStart);
        const key = JSON.parse(source.slice(keyStart, keyEnd + 1));
        const colon = skipJsoncTrivia(source, keyEnd + 1, objectClose);
        if (source[colon] !== ':')
            throw new Error('Invalid JSON/JSONC object property.');
        const valueStart = skipJsoncTrivia(source, colon + 1, objectClose);
        if (key === propertyName) {
            if (found)
                throw new Error(`Duplicate ${propertyName} properties are ambiguous; remove the duplicate before continuing.`);
            found = {
                keyStart,
                valueStart,
                valueEnd: jsonValueEnd(source, valueStart, objectClose),
            };
        }
        const delimiter = valueDelimiter(source, valueStart, objectClose);
        if (delimiter >= objectClose)
            return found;
        index = delimiter + 1;
    }
    return found;
}
function replaceJsonPropertyValue(source, property, value) {
    const indent = lineIndentAt(source, property.keyStart);
    const rendered = JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
    return `${source.slice(0, property.valueStart)}${rendered}${source.slice(property.valueEnd + 1)}`;
}
function insertJsonObjectProperty(source, objectOpen, propertyName, value) {
    const close = matchingBrace(source, objectOpen);
    const inner = source.slice(objectOpen + 1, close);
    const baseIndent = lineIndentAt(source, objectOpen);
    const entryIndent = `${baseIndent}  `;
    const renderedValue = JSON.stringify(value, null, 2).replace(/\n/g, `\n${entryIndent}`);
    const rendered = `${JSON.stringify(propertyName)}: ${renderedValue}`;
    if (!inner.trim()) {
        return `${source.slice(0, objectOpen + 1)}\n${entryIndent}${rendered}\n${baseIndent}${source.slice(close)}`;
    }
    return appendObjectEntry(source, objectOpen, close, entryIndent, rendered);
}
/** Finds an object-valued property at the current object's top level, ignoring strings/comments. */
function findObjectPropertyObject(source, objectOpen, propertyName) {
    const property = findObjectProperty(source, objectOpen, propertyName);
    if (!property)
        return undefined;
    if (source[property.valueStart] !== '{')
        throw new Error(`${propertyName} must be an object.`);
    return {
        keyStart: property.keyStart,
        valueOpen: property.valueStart,
        valueClose: property.valueEnd,
    };
}
/** Removes one top-level JSON property without reformatting its siblings or comments. */
function removeObjectProperty(source, objectOpen, propertyName) {
    const property = findObjectProperty(source, objectOpen, propertyName);
    if (!property)
        return source;
    const objectClose = matchingBrace(source, objectOpen);
    const next = skipJsoncTrivia(source, property.valueEnd + 1, objectClose);
    if (source[next] === ',') {
        return removeSpan(source, property.keyStart, next + 1);
    }
    const previousComma = previousTopLevelComma(source, objectOpen, property.keyStart);
    if (previousComma >= 0) {
        // A comment between that comma and the key belongs to the previous entry:
        // drop only the comma and the property, not the text between them.
        if (/\S/.test(source.slice(previousComma + 1, property.keyStart))) {
            const cut = removeSpan(source, property.keyStart, property.valueEnd + 1);
            return `${cut.slice(0, previousComma)}${cut.slice(previousComma + 1)}`;
        }
        return `${source.slice(0, previousComma)}${source.slice(property.valueEnd + 1)}`;
    }
    return removeSpan(source, property.keyStart, property.valueEnd + 1);
}
/**
 * Cuts `[start, end)`. When the span fills its lines (only indentation before
 * it, only whitespace after it), those whole lines go too, so a removed
 * property leaves no blank, indented line behind.
 */
function removeSpan(source, start, end) {
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = source.indexOf('\n', end);
    if (lineEnd >= 0 &&
        /^[\t ]*$/.test(source.slice(lineStart, start)) &&
        /^[\t \r]*$/.test(source.slice(end, lineEnd))) {
        return `${source.slice(0, lineStart)}${source.slice(lineEnd + 1)}`;
    }
    return `${source.slice(0, start)}${source.slice(end)}`;
}
function rootObjectOpen(source) {
    const open = skipJsoncTrivia(source, 0, source.length);
    if (source[open] !== '{')
        throw new Error('Could not locate the root configuration object.');
    return open;
}
function lineIndentAt(source, index) {
    const lineStart = source.lastIndexOf('\n', index - 1) + 1;
    return source.slice(lineStart, index).match(/^[\t ]*/)?.[0] ?? '';
}
function jsonStringEnd(source, start) {
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
        const character = source[index];
        if (escaped)
            escaped = false;
        else if (character === '\\')
            escaped = true;
        else if (character === '"')
            return index;
    }
    throw new Error('Unterminated JSON string.');
}
function jsonValueEnd(source, start, objectClose) {
    if (source[start] === '{')
        return matchingBrace(source, start);
    if (source[start] === '[')
        return matchingBracket(source, start);
    if (source[start] === '"')
        return jsonStringEnd(source, start);
    let index = start;
    while (index < objectClose &&
        !/[\s,}]/.test(source[index]) &&
        !(source[index] === '/' && (source[index + 1] === '/' || source[index + 1] === '*'))) {
        index += 1;
    }
    if (index === start)
        throw new Error('Invalid JSON/JSONC property value.');
    return index - 1;
}
function valueDelimiter(source, start, objectClose) {
    let objectDepth = 0;
    let arrayDepth = 0;
    for (let index = start; index <= objectClose; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (character === '"') {
            index = jsonStringEnd(source, index);
            continue;
        }
        if (character === '/' && next === '/') {
            index = source.indexOf('\n', index + 2);
            if (index < 0 || index > objectClose)
                return objectClose;
            continue;
        }
        if (character === '/' && next === '*') {
            const end = source.indexOf('*/', index + 2);
            if (end < 0)
                throw new Error('Unterminated JSONC block comment.');
            index = end + 1;
            continue;
        }
        if (index === objectClose && objectDepth === 0 && arrayDepth === 0)
            return index;
        if (character === '{')
            objectDepth += 1;
        else if (character === '}')
            objectDepth -= 1;
        else if (character === '[')
            arrayDepth += 1;
        else if (character === ']')
            arrayDepth -= 1;
        else if (character === ',' && objectDepth === 0 && arrayDepth === 0)
            return index;
    }
    throw new Error('Unterminated JSON/JSONC property value.');
}
function previousTopLevelComma(source, objectOpen, before) {
    let objectDepth = 0;
    let arrayDepth = 0;
    let comma = -1;
    for (let index = objectOpen + 1; index < before; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (character === '"') {
            index = jsonStringEnd(source, index);
            continue;
        }
        if (character === '/' && next === '/') {
            const end = source.indexOf('\n', index + 2);
            if (end < 0 || end >= before)
                break;
            index = end;
            continue;
        }
        if (character === '/' && next === '*') {
            const end = source.indexOf('*/', index + 2);
            if (end < 0)
                throw new Error('Unterminated JSONC block comment.');
            index = end + 1;
            continue;
        }
        if (character === '{')
            objectDepth += 1;
        else if (character === '}')
            objectDepth -= 1;
        else if (character === '[')
            arrayDepth += 1;
        else if (character === ']')
            arrayDepth -= 1;
        else if (character === ',' && objectDepth === 0 && arrayDepth === 0)
            comma = index;
    }
    return comma;
}
function skipJsoncTrivia(source, start, limit) {
    let index = start;
    while (index < limit) {
        if (/\s/.test(source[index])) {
            index += 1;
            continue;
        }
        if (source[index] === '/' && source[index + 1] === '/') {
            const end = source.indexOf('\n', index + 2);
            index = end < 0 ? limit : end + 1;
            continue;
        }
        if (source[index] === '/' && source[index + 1] === '*') {
            const end = source.indexOf('*/', index + 2);
            if (end < 0)
                throw new Error('Unterminated JSONC block comment.');
            index = end + 2;
            continue;
        }
        break;
    }
    return index;
}
function stripJsonComments(source) {
    let output = '';
    let quoted = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (index === 0 && character === '\uFEFF') {
            output += ' ';
            continue;
        }
        if (lineComment) {
            output += character === '\n' ? '\n' : ' ';
            if (character === '\n')
                lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') {
                output += '  ';
                blockComment = false;
                index += 1;
            }
            else {
                output += character === '\n' ? '\n' : ' ';
            }
            continue;
        }
        if (quoted) {
            output += character;
            if (escaped)
                escaped = false;
            else if (character === '\\')
                escaped = true;
            else if (character === '"')
                quoted = false;
            continue;
        }
        if (character === '"') {
            quoted = true;
            output += character;
        }
        else if (character === '/' && next === '/') {
            output += '  ';
            lineComment = true;
            index += 1;
        }
        else if (character === '/' && next === '*') {
            output += '  ';
            blockComment = true;
            index += 1;
        }
        else {
            output += character;
        }
    }
    if (blockComment)
        throw new Error('Unterminated JSONC block comment.');
    return output;
}
function removeTrailingCommas(source) {
    let output = '';
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (quoted) {
            output += character;
            if (escaped)
                escaped = false;
            else if (character === '\\')
                escaped = true;
            else if (character === '"')
                quoted = false;
            continue;
        }
        if (character === '"') {
            quoted = true;
            output += character;
            continue;
        }
        if (character === ',') {
            let next = index + 1;
            while (next < source.length && /\s/.test(source[next]))
                next += 1;
            if (source[next] === '}' || source[next] === ']')
                continue;
        }
        output += character;
    }
    return output;
}
function matchingBrace(source, open) {
    return matchingContainer(source, open, '{', '}', 'object');
}
function matchingBracket(source, open) {
    return matchingContainer(source, open, '[', ']', 'array');
}
function matchingContainer(source, open, openCharacter, closeCharacter, label) {
    let depth = 0;
    let quote = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = open; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (character === '\n')
                lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped)
                escaped = false;
            else if (character === '\\')
                escaped = true;
            else if (character === '"')
                quote = false;
            continue;
        }
        if (character === '/' && next === '/') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (character === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        if (character === '"')
            quote = true;
        else if (character === openCharacter)
            depth += 1;
        else if (character === closeCharacter && --depth === 0)
            return index;
    }
    throw new Error(`Unterminated JSON ${label}.`);
}
/**
 * The one TOML table splitter: `init`/`remove` (`replaceTomlBrainTables`),
 * `doctor` and the duplicate-scope check all read sections through it. A
 * header is a whole line, `[name]` or `[[name]]` with an optional trailing
 * comment; a commented-out header is not one. Each section runs to the next
 * header of either kind, so keys under a following `[[array]]` table never
 * count toward the table before it.
 */
export function splitTomlSections(current) {
    const headers = Array.from(current.matchAll(/^[\t ]*\[(\[?)([^\]\r\n]+)\](\]?)[\t ]*(?:#.*)?$/gm));
    return headers.map((header, index) => {
        const start = header.index;
        const end = headers[index + 1]?.index ?? current.length;
        return {
            name: header[2].trim(),
            isArray: header[1] === '[' && header[3] === ']',
            start,
            end,
            body: current.slice(start + header[0].length, end),
        };
    });
}
//# sourceMappingURL=managed.js.map