// Verify the installed host's turn-tail producer and its persistent input dock.
// No live DSH session, model request, or host installation is modified.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'

const root = process.env.DSH_MODULE_ROOT
if (!root) throw new Error('DSH_MODULE_ROOT is required; run with the installed Electron in Node mode')

const chatFile = path.join(root, 'dsh-client-ui-chat/lib/client.js')
const chatSource = readFileSync(chatFile, 'utf8')
const tailStart = chatSource.indexOf('function tailData(context)')
const definitionStart = chatSource.indexOf('const turnTailDefinition = {', tailStart)
const registrationStart = chatSource.indexOf('function registerTurnTailConversationNode', definitionStart)
assert.ok(tailStart >= 0 && definitionStart > tailStart && registrationStart > definitionStart,
  'installed turn-tail producer must be identifiable')

const { tailData, turnTailDefinition } = vm.runInNewContext(
  chatSource.slice(tailStart, registrationStart) + '\n({ tailData, turnTailDefinition })',
  { turnLocation: () => ({ steps: [], data: new Map() }), hasText: () => false,
    deriveTurnTokenUsage: () => undefined, isSessionEvent: () => false, chatNode: () => ({}) },
)
const openTurn = { state: { turn: 8 }, matches: [{ event: { type: 'turn/start', data: { turn: 8 }, seq: 1 } }] }
assert.equal(turnTailDefinition.match(openTurn.matches[0].event).role, 'start')
assert.equal(turnTailDefinition.publication(openTurn.matches[0]), 'none')
assert.equal(tailData(openTurn), null)
assert.equal(turnTailDefinition.buildLocationData(openTurn, 'turn'), null,
  'a running turn does not publish the turn-tail node')

const ended = { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } }, time: Date.now(), seq: 2 }
const closedTurn = { state: { turn: 8, end: { event: ended } }, matches: [{ event: ended }] }
assert.equal(turnTailDefinition.publication(closedTurn.matches[0]), 'immediate')
assert.equal(turnTailDefinition.buildLocationData(closedTurn, 'turn').key, 'turn-tail',
  'the completed turn publishes its tail')

const conversationFile = path.join(root, 'dsh-client-ui-conversation/lib/client.js')
const conversationSource = readFileSync(conversationFile, 'utf8')
const contentStart = conversationSource.indexOf('function ConversationContent(props)')
const contentEnd = conversationSource.indexOf('//#endregion', contentStart)
const content = conversationSource.slice(contentStart, contentEnd)
assert.ok(contentStart >= 0 && contentEnd > contentStart, 'installed conversation content must be identifiable')
assert.match(content, /const zone = session === void 0 \|\| inputState === void 0 \? void 0 : \{\s*session,\s*input: inputState\s*\}/)
const dock = content.indexOf('zone !== void 0 && renderSlot("conversation.input.dock", zone)')
const input = content.indexOf('inputBar', dock)
assert.ok(dock >= 0 && input > dock, 'the host renders the session input dock before its input bar')

console.log('HOST_CHAT_SHA256=' + createHash('sha256').update(chatSource).digest('hex'))
console.log('HOST_CONVERSATION_SHA256=' + createHash('sha256').update(conversationSource).digest('hex'))
console.log('PASS: the installed host creates turn-tail only after turn/end and continuously renders conversation.input.dock while the session is active')
