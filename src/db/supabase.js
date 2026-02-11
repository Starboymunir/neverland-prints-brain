/**
 * Supabase client (service-role for backend operations)
 */
const { createClient } = require("@supabase/supabase-js");
const config = require("../config");

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

module.exports = supabase;
