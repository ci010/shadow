import { startStartupProfile } from './startup-profile.ts'

// The desktop dev launcher alone arms this explicit capture. No application imports here.
if (process.env.SHADOW_STARTUP_PROFILE_DIR) startStartupProfile(process.env.SHADOW_STARTUP_PROFILE_DIR)
