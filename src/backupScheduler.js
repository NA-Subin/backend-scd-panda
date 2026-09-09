import { runBackup, pruneOldBackups } from './backup.js';

// No cron dependency - just compute how long until the next 1am and
// setTimeout to it, then reschedule for +24h after each run. setTimeout's
// max delay (~24.8 days) comfortably covers one day, so this never
// overflows.
function msUntilNextRun(hour = 1) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function runAndReschedule() {
  try {
    console.log('[backup] เริ่มสำรองข้อมูลอัตโนมัติ...');
    const result = await runBackup();
    console.log(`[backup] สำรองข้อมูลสำเร็จ: ${result.filename}`);
    const removed = await pruneOldBackups();
    if (removed.length > 0) {
      console.log(`[backup] ลบไฟล์สำรองที่เก่าเกิน 30 วัน: ${removed.join(', ')}`);
    }
  } catch (err) {
    console.error('[backup] สำรองข้อมูลอัตโนมัติล้มเหลว:', err);
  } finally {
    scheduleNext();
  }
}

function scheduleNext() {
  const delay = msUntilNextRun(1);
  setTimeout(runAndReschedule, delay);
  console.log(`[backup] ตั้งเวลาสำรองข้อมูลครั้งถัดไปในอีก ${Math.round(delay / 60000)} นาที (ตี 1)`);
}

export function startBackupScheduler() {
  scheduleNext();
}
