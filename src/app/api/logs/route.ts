import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { level, message, data } = body;
    
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    
    if (data) {
      console.log(logMessage, JSON.stringify(data, null, 2));
    } else {
      console.log(logMessage);
    }
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Log error:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}