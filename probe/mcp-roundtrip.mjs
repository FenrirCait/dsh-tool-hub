import { readFile, writeFile } from 'node:fs/promises'
import { parseMcpRows, replaceMcpConfig } from '../lib/mcp.js'

const source = 'C:/Users/fenri/.dsh/profiles/desktop/cordis.patch.yml'
const text = await readFile(source, 'utf8')
const rows = parseMcpRows(text)
console.log('rows:', rows.length)
for (const row of rows) {
  console.log(row.id, '|', row.config.serverName, '|', row.config.transport, '|', JSON.stringify(row.config.args), '|', JSON.stringify(row.config.reconnect), '| disabled', row.disabled, '| lines', row.startLine, row.endLine, '| config', row.configStart, row.configEnd)
}

const target = rows[0]
const next = structuredClone(target.config)
next.serverName = 'illustrator-renamed'
next.args = ['C:\\a b\\index.js', '--flag']
next.env = { FOO: 'bar', PATH2: 'C:\\x' }
next.failOnStartupError = true
const rewritten = replaceMcpConfig(text, target.id, next)
const again = parseMcpRows(rewritten).find(row => row.id === target.id)
console.log('rewritten:', JSON.stringify(again.config))

const beforeLines = text.split(/\r?\n/)
const afterLines = rewritten.split(/\n/)
console.log('line delta:', afterLines.length - beforeLines.length)
let changed = 0
for (const line of afterLines) if (!beforeLines.includes(line)) changed += 1
console.log('new-or-changed lines:', changed)
await writeFile('probe/mcp-rewrite-preview.yml', rewritten, 'utf8')
console.log('wrote probe/mcp-rewrite-preview.yml')
