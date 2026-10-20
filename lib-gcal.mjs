// lib-gcal.mjs — Google Calendar API ヘルパー
import { google } from 'googleapis';
import { keychain } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA = path.join(os.homedir(), '.local/share/sirius-fetch');
const TOKEN_PATH = path.join(DATA, 'google-token.json');

export function getCalendarClient() {
  const clientId = keychain('gcal-client-id');
  const clientSecret = keychain('gcal-client-secret');
  if (!clientId || !clientSecret) return null;

  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials(tokens);

  auth.on('tokens', (fresh) => {
    const merged = { ...tokens, ...fresh };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    tokens = merged;
  });

  return google.calendar({ version: 'v3', auth });
}

export async function createAllDayEvent(cal, { calendarId, summary, date, endDate, description }) {
  const res = await cal.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      start: { date },
      end: { date: endDate },
    },
  });
  return res.data;
}
