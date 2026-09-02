// Crea (idempotente) los monitores de UptimeRobot (API v3): API /health y Web /.
// Uso: pnpm monitors --api-url https://... --web-url https://...  (cualquiera de los dos es opcional)
import { readEnvFile } from './lib.mjs';

const setup = readEnvFile();
const apiKey = setup.UPTIMEROBOT_API_KEY;
const alertEmail = setup.UPTIMEROBOT_ALERT_EMAIL;
if (!apiKey) throw new Error('Falta UPTIMEROBOT_API_KEY');
if (!alertEmail) throw new Error('Falta UPTIMEROBOT_ALERT_EMAIL');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const apiUrl = arg('--api-url');
const webUrl = arg('--web-url');
if (!apiUrl && !webUrl) throw new Error('Indica --api-url y/o --web-url');

async function ur(method, path, body) {
  const res = await fetch(`https://api.uptimerobot.com/v3${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(`UptimeRobot ${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// 1) Contacto de alerta por correo (se crea si no existe).
const contacts = (await ur('GET', '/alert-contacts')).data ?? [];
let contact = contacts.find((c) => c.type === 'Email' && c.value === alertEmail);
if (!contact) {
  contact = await ur('POST', '/alert-contacts', {
    type: 'Email',
    value: alertEmail,
    friendlyName: 'AYR Steel ERP',
  });
  console.log('Contacto de alerta creado. Requiere confirmar el correo.');
}
const assignedAlertContacts = [{ alertContactId: Number(contact.id), threshold: 0, recurrence: 0 }];

// 2) Monitores cada 5 minutos. El del API exige la palabra clave "status":"ok" en el cuerpo.
const common = { interval: 300, timeout: 30, assignedAlertContacts };
const wanted = [];
if (apiUrl) {
  wanted.push({
    ...common,
    type: 'KEYWORD',
    friendlyName: 'AYR Steel ERP - API /health',
    url: `${apiUrl.replace(/[/]$/, '')}/health`,
    keywordType: 'ALERT_NOT_EXISTS',
    keywordCaseType: 'CaseSensitive',
    keywordValue: '"status":"ok"',
  });
}
if (webUrl) {
  wanted.push({ ...common, type: 'HTTP', friendlyName: 'AYR Steel ERP - Web', url: webUrl });
}

const existing = (await ur('GET', '/monitors')).data ?? [];
for (const m of wanted) {
  const found = existing.find((e) => e.friendlyName === m.friendlyName);
  if (found) {
    await ur('PATCH', `/monitors/${found.id}`, m);
    console.log(`- ${m.friendlyName}: actualizado (id ${found.id}) -> ${m.url}`);
  } else {
    const created = await ur('POST', '/monitors', m);
    console.log(`- ${m.friendlyName}: creado (id ${created.id}) -> ${m.url}`);
  }
}
console.log('Monitores listos.');
