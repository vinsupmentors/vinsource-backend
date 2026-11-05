-- The phone app re-sent some calls, creating identical AUTO call-log rows. Keep one row per call, preferring the one that has a recording / the oldest.
DELETE a FROM `LeadCallLog` a
JOIN `LeadCallLog` b
  ON a.`source` = 'AUTO' AND b.`source` = 'AUTO'
 AND a.`deviceId` = b.`deviceId`
 AND a.`rawPhoneNumber` = b.`rawPhoneNumber`
 AND a.`calledAt` = b.`calledAt`
 AND (a.`direction` <=> b.`direction`)
 AND (a.`durationSeconds` <=> b.`durationSeconds`)
 AND a.`id` <> b.`id`
WHERE a.`recordingUrl` IS NULL
  AND (b.`recordingUrl` IS NOT NULL OR b.`id` < a.`id`);
