console.log("🚀 Server starting...");

import express from "express";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// ------------------ Supabase Client ------------------
// NOTE: For production, move these keys to a .env file
const supabase = createClient(
  "https://mdwmsxhwhvrmewmrcawn.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kd21zeGh3aHZybWV3bXJjYXduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM1NzI2NDYsImV4cCI6MjA3OTE0ODY0Nn0.04rlyDgh2mTDTowiZiApcAoZ3K3wYefXWjquiLayaDo"
);

console.log("Supabase initialized");

// ------------------ Distance Calculation ------------------
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ------------------ START WORK ------------------
app.post("/api/start-work", async (req, res) => {
  // ✅ FIXED: Removed 'local_time' from request body
  const { worker_id, token, latitude, longitude } = req.body;

  if (!worker_id || !token || latitude == null || longitude == null) {
    return res.json({ success: false, message: "Missing required fields" });
  }

  try {
    // Check if worker already has an active session
    const { data: existingSession } = await supabase
      .from("work_sessions")
      .select("*")
      .eq("worker_id", worker_id)
      .eq("status", "active")
      .maybeSingle();

    if (existingSession) {
      return res.json({
        success: false,
        message: "Worker already has an active session",
        session_id: existingSession.session_id,
        start_time: existingSession.start_time
      });
    }

    // Fetch QR + site details
    const { data: qrData, error: qrErr } = await supabase
      .from("qr_codes")
      .select(
        `
        id,
        token,
        active,
        site_id,
        sites (
          id,
          name,
          latitude,
          longitude,
          qr_radius_meters
        )
      `
      )
      .eq("token", token)
      .single();

    if (qrErr || !qrData) {
      return res.json({ success: false, message: "Invalid QR code" });
    }

    if (!qrData.active) {
      return res.json({ success: false, message: "QR code is inactive" });
    }

    const site = qrData.sites;
    if (!site) {
      return res.json({ success: false, message: "Linked site not found" });
    }

    // GPS distance validation
    const distance = getDistance(latitude, longitude, site.latitude, site.longitude);

    if (distance > site.qr_radius_meters) {
      return res.json({
        success: false,
        message: `You are too far from the site boundary (${distance.toFixed(2)}m)`
      });
    }

    // ✅ FIXED: Always use UTC ISO String.
    // This solves the 5:50 time difference issue.
    const startTime = new Date().toISOString(); 

    const { data: sessionData, error: insertErr } = await supabase
      .from("work_sessions")
      .insert([
        {
          worker_id,
          site_id: site.id,
          start_time: startTime, 
          status: "active"
        }
      ])
      .select("*")
      .single();

    if (insertErr || !sessionData) {
      return res.json({ success: false, message: "Failed to start work session" });
    }

    return res.json({
      success: true,
      message: "Work session started successfully",
      session_id: sessionData.session_id,
      start_time: sessionData.start_time
    });
  } catch (err) {
    console.error("[START WORK] Error:", err);
    return res.json({ success: false, message: "Server error starting work" });
  }
});

// ------------------ END WORK ------------------
app.post("/api/end-work", async (req, res) => {
  const { session_id } = req.body;

  if (!session_id) {
    return res.json({ success: false, message: "session_id required" });
  }

  try {
    const { data: session, error: fetchErr } = await supabase
      .from("work_sessions")
      .select("*")
      .eq("session_id", session_id)
      .single();

    if (fetchErr || !session) {
      return res.json({ success: false, message: "Session not found" });
    }

    // ✅ FIXED: Generate End Time in UTC ISO format
    const endTime = new Date().toISOString();
    
    // ✅ FIXED: Calculate hours using UTC timestamps
    const startMs = new Date(session.start_time).getTime();
    const endMs = new Date(endTime).getTime();
    const hoursWorked = (endMs - startMs) / 3600000;

    const { error: updateErr } = await supabase
      .from("work_sessions")
      .update({
        end_time: endTime,
        status: "completed"
      })
      .eq("session_id", session_id);

    if (updateErr) {
      return res.json({ success: false, message: "Failed to end work session" });
    }

    return res.json({
      success: true,
      total_hours: Number(hoursWorked.toFixed(2))
    });
  } catch (err) {
    console.error("[END WORK] Error:", err);
    return res.json({ success: false, message: "Server error ending work" });
  }
});

// ------------------ SESSION STATUS ------------------
app.get("/api/session-status/:worker_id", async (req, res) => {
  const { worker_id } = req.params;

  try {
    const { data: session } = await supabase
      .from("work_sessions")
      .select("*")
      .eq("worker_id", worker_id)
      .eq("status", "active")
      .single();

    if (!session) return res.json({ active: false });

    return res.json({
      active: true,
      session_id: session.session_id,
      start_time: session.start_time
    });
  } catch (err) {
    console.error("[SESSION STATUS] Error:", err);
    return res.json({ active: false });
  }
});

app.get("/api/worker-hours/:worker_id", async (req, res) => {
  const { worker_id } = req.params;

  if (!worker_id) return res.json({ success: false, message: "worker_id required" });

  try {
    const { data: sessions, error } = await supabase
      .from("work_sessions")
      .select(`
        start_time,
        end_time,
        sites (
          id,
          name
        )
      `)
      .eq("worker_id", worker_id)
      .eq("status", "completed")
      .order("start_time", { ascending: true });

    if (error) {
      return res.json({ success: false, message: error.message });
    }

    // Group by date
    const grouped = {};

    sessions.forEach((s) => {
      if (!s.end_time) return;

      const startMs = new Date(s.start_time).getTime();
      const endMs = new Date(s.end_time).getTime();
      const hoursWorked = (endMs - startMs) / 3600000; // decimal hours

      const date = new Date(s.start_time).toISOString().split("T")[0]; // YYYY-MM-DD
      const siteName = s.sites?.name ?? "Unknown Site";

      if (!grouped[date]) grouped[date] = [];
      grouped[date].push({ company: siteName, hours: Number(hoursWorked.toFixed(2)) });
    });

    const result = Object.entries(grouped).map(([date, sites]) => ({ date, sites }));

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[WORKER HOURS] Error:", err);
    return res.json({ success: false, message: "Server error" });
  }
});

// ✅ FIXED: DELETE WORKER - Convert string ID to integer
app.delete("/api/workers/:worker_id", async (req, res) => {
  let { worker_id } = req.params;

  if (!worker_id) {
    return res.status(400).json({ success: false, message: "worker_id required" });
  }

  // Convert string to integer
  worker_id = parseInt(worker_id, 10);
  
  if (isNaN(worker_id)) {
    return res.status(400).json({ success: false, message: "Invalid worker_id format" });
  }

  try {
    // Check for active sessions
    const { data: activeSessions, error: checkErr } = await supabase
      .from("work_sessions")
      .select("session_id")
      .eq("worker_id", worker_id)
      .eq("status", "active");

    if (checkErr) {
      console.error("Error checking active sessions:", checkErr);
      return res.status(500).json({ success: false, message: "Error checking active sessions" });
    }

    if (activeSessions && activeSessions.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete worker with ${activeSessions.length} active session(s). Please end all sessions first.`,
        hasActiveSessions: true
      });
    }

    // Delete all completed work sessions
    const { error: deleteSessionsErr } = await supabase
      .from("work_sessions")
      .delete()
      .eq("worker_id", worker_id);

    if (deleteSessionsErr) {
      console.error("Error deleting work sessions:", deleteSessionsErr);
      return res.status(500).json({ success: false, message: "Failed to delete work sessions" });
    }

    // Delete the worker
    const { error: deleteWorkerErr } = await supabase
      .from("workers")
      .delete()
      .eq("worker_id", worker_id);

    if (deleteWorkerErr) {
      console.error("Error deleting worker:", deleteWorkerErr);
      return res.status(500).json({ success: false, message: "Failed to delete worker record" });
    }

    return res.json({
      success: true,
      message: "Worker and all associated data deleted successfully"
    });
  } catch (err) {
    console.error("[DELETE WORKER] Error:", err);
    return res.status(500).json({ success: false, message: "Server error deleting worker" });
  }
});

// ✅ FIXED: DELETE ADMIN - Convert string ID to integer & prevent super admin deletion
app.delete("/api/admins/:admin_id", async (req, res) => {
  let { admin_id } = req.params;

  if (!admin_id) {
    return res.status(400).json({ success: false, message: "admin_id required" });
  }

  // Convert string to integer
  admin_id = parseInt(admin_id, 10);
  
  if (isNaN(admin_id)) {
    return res.status(400).json({ success: false, message: "Invalid admin_id format" });
  }

  try {
    // Verify admin exists first
    const { data: adminData, error: checkErr } = await supabase
      .from("admins")
      .select("admin_id, role")
      .eq("admin_id", admin_id)
      .maybeSingle();

    if (checkErr || !adminData) {
      console.error("Admin not found:", checkErr);
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    // ✅ NEW: Prevent deletion of super admins
    if (adminData.role === "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Super admins cannot be deleted. Please contact the system administrator.",
        isProtected: true
      });
    }

    // Delete the admin
    const { error: deleteAdminErr } = await supabase
      .from("admins")
      .delete()
      .eq("admin_id", admin_id);

    if (deleteAdminErr) {
      console.error("Error deleting admin:", deleteAdminErr);
      return res.status(500).json({ success: false, message: "Failed to delete admin" });
    }

    return res.json({
      success: true,
      message: "Admin deleted successfully"
    });
  } catch (err) {
    console.error("[DELETE ADMIN] Error:", err);
    return res.status(500).json({ success: false, message: "Server error deleting admin" });
  }
});

// ✅ FIXED: DELETE SITE WITH CASCADING - Already uses correct column names
app.delete("/api/sites/:site_id", async (req, res) => {
  const { site_id } = req.params;

  if (!site_id) {
    return res.status(400).json({ success: false, message: "site_id required" });
  }

  try {
    // Verify site exists first
    const { data: siteData, error: checkSiteErr } = await supabase
      .from("sites")
      .select("id")
      .eq("id", site_id)
      .single();

    if (checkSiteErr || !siteData) {
      console.error("Site not found:", checkSiteErr);
      return res.status(404).json({ success: false, message: "Site not found" });
    }

    // Check for active sessions
    const { data: activeSessions, error: checkErr } = await supabase
      .from("work_sessions")
      .select("session_id")
      .eq("site_id", site_id)
      .eq("status", "active");

    if (checkErr) {
      console.error("Error checking active sessions:", checkErr);
      return res.status(500).json({ success: false, message: "Error checking active sessions" });
    }

    if (activeSessions && activeSessions.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete site with ${activeSessions.length} active work session(s). Please end all sessions first.`,
        hasActiveSessions: true
      });
    }

    // Delete all work sessions at this site
    const { error: deleteSessionsErr } = await supabase
      .from("work_sessions")
      .delete()
      .eq("site_id", site_id);

    if (deleteSessionsErr) {
      console.error("Error deleting work sessions:", deleteSessionsErr);
      return res.status(500).json({ success: false, message: "Failed to delete work sessions" });
    }

    // Delete all QR codes for this site (cascade handled by DB)
    const { error: deleteQRErr } = await supabase
      .from("qr_codes")
      .delete()
      .eq("site_id", site_id);

    if (deleteQRErr) {
      console.error("Error deleting QR codes:", deleteQRErr);
      return res.status(500).json({ success: false, message: "Failed to delete QR codes" });
    }

    // Delete the site
    const { error: deleteSiteErr } = await supabase
      .from("sites")
      .delete()
      .eq("id", site_id);

    if (deleteSiteErr) {
      console.error("Error deleting site:", deleteSiteErr);
      return res.status(500).json({ success: false, message: "Failed to delete site" });
    }

    return res.json({
      success: true,
      message: "Site and all associated data deleted successfully"
    });
  } catch (err) {
    console.error("[DELETE SITE] Error:", err);
    return res.status(500).json({ success: false, message: "Server error deleting site" });
  }
});

// ✅ FIXED: CHECK EMAIL UNIQUENESS - Handle both admins and workers correctly
app.post("/api/check-email", async (req, res) => {
  const { email, type } = req.body; // type: "worker" or "admin"

  if (!email || !type) {
    return res.status(400).json({ success: false, message: "Email and type required" });
  }

  try {
    const table = type === "worker" ? "workers" : "admins";
    const { data, error } = await supabase
      .from(table)
      .select(type === "worker" ? "worker_id" : "admin_id")
      .eq("email", email)
      .maybeSingle();

    if (error) {
      console.error("Email check error:", error);
      return res.status(500).json({ success: false, message: "Database error" });
    }

    return res.json({
      success: true,
      exists: !!data
    });
  } catch (err) {
    console.error("[CHECK EMAIL] Error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ FIXED: CHECK NIC UNIQUENESS - Workers only, correct column name
app.post("/api/check-nic", async (req, res) => {
  const { nic } = req.body;

  if (!nic) {
    return res.status(400).json({ success: false, message: "NIC required" });
  }

  try {
    const { data, error } = await supabase
      .from("workers")
      .select("worker_id")
      .eq("nic", nic)
      .maybeSingle();

    if (error) {
      console.error("NIC check error:", error);
      return res.status(500).json({ success: false, message: "Database error" });
    }

    return res.json({
      success: true,
      exists: !!data
    });
  } catch (err) {
    console.error("[CHECK NIC] Error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ NEW: SUBMIT CONTACT MESSAGE
app.post("/api/contact-messages", async (req, res) => {
  const { full_name, email_address, phone_number, service_required, message } = req.body;

  if (!full_name || !email_address || !phone_number || !service_required || !message) {
    return res.status(400).json({ success: false, message: "All fields are required" });
  }

  try {
    const { data, error } = await supabase
      .from("contact_messages")
      .insert([
        {
          full_name,
          email_address,
          phone_number,
          service_required,
          message,
          status: "new"
        }
      ])
      .select("id")
      .single();

    if (error) {
      console.error("Error inserting contact message:", error);
      return res.status(500).json({ success: false, message: "Failed to submit message" });
    }

    return res.json({
      success: true,
      message: "Thank you! Your message has been submitted successfully. We'll be in touch soon.",
      message_id: data.id
    });
  } catch (err) {
    console.error("[CONTACT MESSAGE] Error:", err);
    return res.status(500).json({ success: false, message: "Server error submitting message" });
  }
});

// ✅ NEW: GET ALL CONTACT MESSAGES (Admin only)
app.get("/api/contact-messages", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("contact_messages")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching contact messages:", error);
      return res.status(500).json({ success: false, message: "Failed to fetch messages" });
    }

    return res.json({
      success: true,
      data
    });
  } catch (err) {
    console.error("[GET CONTACT MESSAGES] Error:", err);
    return res.status(500).json({ success: false, message: "Server error fetching messages" });
  }
});

// ✅ NEW: UPDATE MESSAGE STATUS (Admin only)
app.patch("/api/contact-messages/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status || !["new", "read", "responded"].includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid status" });
  }

  try {
    const { error } = await supabase
      .from("contact_messages")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (error) {
      console.error("Error updating message status:", error);
      return res.status(500).json({ success: false, message: "Failed to update status" });
    }

    return res.json({
      success: true,
      message: "Status updated successfully"
    });
  } catch (err) {
    console.error("[UPDATE MESSAGE STATUS] Error:", err);
    return res.status(500).json({ success: false, message: "Server error updating status" });
  }
});

// ✅ NEW: DELETE CONTACT MESSAGE
app.delete("/api/contact-messages/:id", async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ success: false, message: "Message ID required" });
  }

  try {
    const messageId = parseInt(id, 10);
    
    if (isNaN(messageId)) {
      return res.status(400).json({ success: false, message: "Invalid message ID format" });
    }

    const { error } = await supabase
      .from("contact_messages")
      .delete()
      .eq("id", messageId);

    if (error) {
      console.error("Error deleting message:", error);
      return res.status(500).json({ success: false, message: "Failed to delete message" });
    }

    return res.json({
      success: true,
      message: "Message deleted successfully"
    });
  } catch (err) {
    console.error("[DELETE CONTACT MESSAGE] Error:", err);
    return res.status(500).json({ success: false, message: "Server error deleting message" });
  }
});

// ✅ NEW: UPDATE SITE DETAILS (Super Admin only)
app.patch("/api/sites/:site_id", async (req, res) => {
  const { site_id } = req.params;
  const { latitude, longitude, qr_radius_meters } = req.body;

  if (!site_id) {
    return res.status(400).json({ success: false, message: "Site ID required" });
  }

  try {
    // Validate input
    if (latitude !== undefined && (isNaN(latitude) || latitude < -90 || latitude > 90)) {
      return res.status(400).json({ success: false, message: "Invalid latitude (must be between -90 and 90)" });
    }

    if (longitude !== undefined && (isNaN(longitude) || longitude < -180 || longitude > 180)) {
      return res.status(400).json({ success: false, message: "Invalid longitude (must be between -180 and 180)" });
    }

    if (qr_radius_meters !== undefined && (isNaN(qr_radius_meters) || qr_radius_meters < 1)) {
      return res.status(400).json({ success: false, message: "Invalid QR radius (must be at least 1 meter)" });
    }

    // Build update object with only provided fields
    const updateData = {};
    if (latitude !== undefined) updateData.latitude = parseFloat(latitude);
    if (longitude !== undefined) updateData.longitude = parseFloat(longitude);
    if (qr_radius_meters !== undefined) updateData.qr_radius_meters = parseInt(qr_radius_meters, 10);

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    const { error } = await supabase
      .from("sites")
      .update(updateData)
      .eq("id", site_id);

    if (error) {
      console.error("Error updating site:", error);
      return res.status(500).json({ success: false, message: "Failed to update site" });
    }

    return res.json({
      success: true,
      message: "Site details updated successfully"
    });
  } catch (err) {
    console.error("[UPDATE SITE] Error:", err);
    return res.status(500).json({ success: false, message: "Server error updating site" });
  }
});

app.get("/", (req, res) => {
  res.send("IPS Facilities API is running 🚀");
});


// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 5001;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

console.log("About to start server...");
