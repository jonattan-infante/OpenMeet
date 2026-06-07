import { NextResponse } from 'next/server';

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_APP_ID = process.env.CLOUDFLARE_APP_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_PRESET_NAME = process.env.CLOUDFLARE_PRESET_NAME || 'group_call_participant';

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
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

    const participantId = `user-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // First, try to add participant to existing meeting
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
    
    console.log('Add participant response:', JSON.stringify({ status: addResponse.status, data: addData }));
    
    // If meeting doesn't exist, create it first
    if (!addResponse.ok && addData.error?.code === 404) {
      const createUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${CLOUDFLARE_APP_ID}/meetings`;
      
      const createResponse = await fetch(createUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ meeting_id: meetingId })
      });
      
      const createData = await createResponse.json();
      
      if (!createResponse.ok) {
        return NextResponse.json({ 
          error: 'Failed to create meeting',
          details: createData 
        }, { status: createResponse.status });
      }

      // Use the actual meeting ID from response
      const actualMeetingId = createData.data?.id || meetingId;
      
      const retryResponse = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${CLOUDFLARE_APP_ID}/meetings/${actualMeetingId}/participants`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ 
            custom_participant_id: participantId,
            preset_name: CLOUDFLARE_PRESET_NAME
          })
        }
      );
      
      const retryData = await retryResponse.json();
      
      if (!retryResponse.ok) {
        return NextResponse.json({ 
          error: 'Failed to add participant',
          details: retryData 
        }, { status: retryResponse.status });
      }
      
      return NextResponse.json({ 
        authToken: retryData.data?.token,
        meetingId: actualMeetingId
      });
    }
    
    if (!addResponse.ok) {
      return NextResponse.json({ 
        error: addData.error?.message || 'Failed to add participant',
        details: addData 
      }, { status: addResponse.status });
    }

    return NextResponse.json({ 
      authToken: addData.data?.token,
      meetingId 
    });
    
  } catch (error) {
    console.error('Exception in token route:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
