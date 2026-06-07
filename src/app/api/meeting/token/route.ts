import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_APP_ID = process.env.CLOUDFLARE_APP_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_PRESET_NAME = process.env.CLOUDFLARE_PRESET_NAME || 'group_call_participant';

const STORE_FILE = path.join(process.cwd(), '.meetings.json');

// Simple persistent store for meeting mappings
async function getMeetingStore(): Promise<Map<string, string>> {
  try {
    const data = await fs.readFile(STORE_FILE, 'utf-8');
    const obj = JSON.parse(data);
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

async function saveMeetingStore(store: Map<string, string>) {
  const obj = Object.fromEntries(store);
  await fs.writeFile(STORE_FILE, JSON.stringify(obj, null, 2));
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function addParticipant(meetingId: string, participantId: string) {
  const addUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${CLOUDFLARE_APP_ID}/meetings/${meetingId}/participants`;
  
  const addResponse = await fetch(addUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ 
      custom_participant_id: participantId,
      preset_name: CLOUDFLARE_PRESET_NAME
    })
  });

  const addData = await addResponse.json();
  
  if (!addResponse.ok) {
    return { success: false as const, status: addResponse.status, data: addData };
  }

  return { success: true as const, token: addData.data?.token };
}

async function createMeeting(clientMeetingId: string) {
  const createUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${CLOUDFLARE_APP_ID}/meetings`;
  
  const createResponse = await fetch(createUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ meeting_id: clientMeetingId })
  });
  
  const createData = await createResponse.json();
  
  if (!createResponse.ok) {
    return { success: false as const, status: createResponse.status, data: createData };
  }

  return { success: true as const, cloudflareMeetingId: createData.data?.id };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    let { meetingId } = body;

    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_APP_ID || !CLOUDFLARE_API_TOKEN) {
      return NextResponse.json({ error: 'Missing Cloudflare credentials' }, { status: 500 });
    }

    // Generate UUID for meeting if not provided
    if (!meetingId) {
      meetingId = generateUUID();
    }

    // Ensure meetingId is a valid UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(meetingId)) {
      meetingId = generateUUID();
    }

    const clientMeetingId = meetingId;
    const store = await getMeetingStore();

    // Check if we already have a Cloudflare meeting ID for this client ID
    let cloudflareMeetingId = store.get(clientMeetingId);
    console.log('Meeting store lookup:', { clientMeetingId, cloudflareMeetingId: cloudflareMeetingId || 'not found' });

    const participantId = `user-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    if (cloudflareMeetingId) {
      // We have an existing Cloudflare meeting - try to add participant directly
      console.log('Using existing Cloudflare meeting:', cloudflareMeetingId);
      const result = await addParticipant(cloudflareMeetingId, participantId);
      
      if (result.success) {
        return NextResponse.json({ 
          authToken: result.token,
          meetingId: cloudflareMeetingId
        });
      }
      
      // If adding failed (e.g., meeting was deleted), fall through to create new
      console.log('Failed to add to existing meeting, will create new:', result.data);
    }

    // Try to add participant using client ID (meeting might already exist in Cloudflare)
    console.log('Trying to add participant with client ID:', clientMeetingId);
    const directResult = await addParticipant(clientMeetingId, participantId);
    
    if (directResult.success) {
      // Cloudflare already had this meeting - store the mapping
      store.set(clientMeetingId, clientMeetingId);
      await saveMeetingStore(store);
      console.log('Meeting existed in Cloudflare, stored mapping:', clientMeetingId);
      return NextResponse.json({ 
        authToken: directResult.token,
        meetingId: clientMeetingId
      });
    }

    console.log('Meeting does not exist in Cloudflare, creating new...');
    
    // Create new meeting in Cloudflare
    const createResult = await createMeeting(clientMeetingId);
    
    if (!createResult.success) {
      return NextResponse.json({ 
        error: 'Failed to create meeting',
        details: createResult.data 
      }, { status: createResult.status });
    }

    const finalMeetingId = createResult.cloudflareMeetingId || clientMeetingId;
    cloudflareMeetingId = finalMeetingId;
    console.log('Created new Cloudflare meeting:', finalMeetingId);
    
    // Store the mapping
    store.set(clientMeetingId, finalMeetingId);
    await saveMeetingStore(store);
    
    // Add participant to the newly created meeting
    const retryResult = await addParticipant(finalMeetingId, participantId);
    
    if (!retryResult.success) {
      return NextResponse.json({ 
        error: 'Failed to add participant to new meeting',
        details: retryResult.data 
      }, { status: retryResult.status });
    }
    
    return NextResponse.json({ 
      authToken: retryResult.token,
      meetingId: finalMeetingId
    });
    
  } catch (error) {
    console.error('Exception in token route:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
