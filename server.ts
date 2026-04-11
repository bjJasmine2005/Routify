import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { connectDB } from "./src/lib/db.js";
import { Institution, User, Vehicle, Route, Student, Trip, TripAttendance, Notice } from "./src/lib/models.js";
import { sendEmail } from "./src/lib/mailer.js";
import crypto from "crypto";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is not set in environment variables!');
  process.exit(1);
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authMiddleware(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    req.user = jwt.verify(authHeader.split(" ")[1], JWT_SECRET!) as any;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── Super Admin Auth Middleware ──────────────────────────────────────────────
function superAdminMiddleware(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], JWT_SECRET!) as any;
    if (decoded.role !== 'superadmin') {
      return res.status(403).json({ error: "Forbidden: Super admin access required" });
    }
    req.superAdmin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

async function startServer() {
  // Connect to MongoDB first
  await connectDB();

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });

  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/views"));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cors());
  app.use(express.static(path.join(process.cwd(), "public")));

  // ─── Socket.io ────────────────────────────────────────────────────────────
  io.on("connection", (socket) => {
    socket.on("join-institution", (institutionId) => {
      socket.join(`inst_${institutionId}`);
    });

    socket.on("trip:start", async (data) => {
      const { institutionId, tripId, routeId, vehicleId } = data;
      if (!institutionId || !tripId) return;
      
      await Trip.findByIdAndUpdate(tripId, { 
        institution_id: institutionId,
        route_id: routeId || 'default',
        status: 'active', 
        started_at: new Date() 
      }, { upsert: true });

      io.to(`inst_${institutionId}`).emit("trip:started", data);
    });

    socket.on("location:update", async (data) => {
      const { institutionId, tripId, lat, lng } = data;
      if (!institutionId || !tripId) return;
      
      await Trip.findByIdAndUpdate(tripId, { 
        current_lat: lat, 
        current_lng: lng,
        institution_id: institutionId
      }, { upsert: true });

      io.to(`inst_${institutionId}`).emit("location:updated", data);
    });

    socket.on("trip:end", async (data) => {
      const { institutionId, tripId } = data;
      if (!institutionId || !tripId) return;
      
      const trip = await Trip.findById(tripId);
      let duration_seconds: number | undefined;
      if (trip?.started_at) {
        duration_seconds = Math.floor((Date.now() - trip.started_at.getTime()) / 1000);
      }

      await Trip.findByIdAndUpdate(tripId, { 
        status: 'completed', 
        ended_at: new Date(),
        ...(duration_seconds !== undefined ? { duration_seconds } : {})
      });

      io.to(`inst_${institutionId}`).emit("trip:ended", data);
    });

    // Attendance update via socket (for real-time parent notification)
    socket.on("attendance:update", async (data) => {
      const { institutionId, tripId, studentId, status } = data;
      if (!institutionId || !tripId || !studentId) return;
      io.to(`inst_${institutionId}`).emit("attendance:updated", { tripId, studentId, status });
    });
  });

  // ─── Institution Info ──────────────────────────────────────────────────────
  app.get("/api/institution", authMiddleware, async (req: any, res) => {
    const inst = await Institution.findById(req.user.institutionId);
    if (!inst) return res.status(404).json({ error: "Institution not found" });
    res.json({ id: inst._id, name: inst.name, email: inst.email });
  });

  // Pin student location (Parent Portal)
  app.post("/api/parent/:token/pin", async (req, res) => {
    const { lat, lng, address } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: "Coordinates required" });
    try {
      const student = await Student.findOneAndUpdate(
        { access_token: req.params.token },
        { pickup_lat: lat, pickup_lng: lng, pickup_location: address || undefined },
        { new: true }
      );
      if (!student) return res.status(404).json({ error: "Student not found" });
      res.json({ message: "Stop location pinned!", student });
    } catch { res.status(500).json({ error: "Failed to pin location" }); }
  });

  // Resend Parent Portal Email
  app.post("/api/students/:id/resend-portal", authMiddleware, async (req: any, res) => {
    try {
      const student = await Student.findOne({ _id: req.params.id, institution_id: req.user.institutionId });
      if (!student) return res.status(404).json({ error: "Student not found" });

      const inst = await Institution.findById(req.user.institutionId);
      const portalUrl = `${process.env.APP_URL || `http://localhost:${PORT}`}/parent/portal/${student.access_token}`;

      await sendEmail(student.parent_email, `Your child's bus tracker — ${inst?.name || 'School'}`,
        `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <div style="background:#2563eb;padding:20px 24px;border-radius:16px 16px 0 0;">
            <h1 style="color:white;margin:0;font-size:24px">🚌 Routify</h1>
          </div>
          <div style="background:#f8fafc;padding:24px;border-radius:0 0 16px 16px;border:1px solid #e2e8f0">
            <h2 style="color:#1e293b;margin-top:0">Friendly Reminder: Tracking Portal</h2>
            <p style="color:#64748b;line-height:1.6">You can track <strong>${student.name}</strong>'s school bus in real-time. Please remember to <strong>pin your stop location</strong> for better accuracy.</p>
            
            <div style="background:#eff6ff;padding:20px;border-radius:12px;margin:24px 0;border-left:4px solid #2563eb">
              <h3 style="color:#1e40af;margin-top:0;font-size:16px">📍 Pin Your Bus Stop</h3>
              <p style="color:#1e40af;font-size:14px;margin-bottom:16px">Open the portal and use the "Pin Your Stop" tool to mark the exact spot where the bus should stop.</p>
              <a href="${portalUrl}" style="display:inline-block;background:#2563eb;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700">Open Tracking Portal →</a>
            </div>
            <p style="color:#94a3b8;font-size:12px;margin-top:24px">Powered by Routify</p>
          </div>
        </div>`
      );
      res.json({ message: "Reminder sent successfully!" });
    } catch { res.status(500).json({ error: "Failed to send email" }); }
  });

  // ─── Auth API ─────────────────────────────────────────────────────────────
  app.post("/api/auth/register", async (req, res) => {
    const { schoolName, email, password } = req.body;
    if (!schoolName || !email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }
    try {
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) return res.status(409).json({ error: "An account with this email already exists" });

      const id = uuidv4();
      const hashed = await bcrypt.hash(password, 10);
      const institutionId = uuidv4();
      await Institution.create({ _id: institutionId, name: schoolName, email: email.toLowerCase() });
      const user = await User.create({ _id: id, institution_id: institutionId, name: schoolName, email: email.toLowerCase(), password: hashed, role: 'admin' });
      const token = jwt.sign({ id: user._id, institutionId, role: 'admin' }, JWT_SECRET!, { expiresIn: '7d' });
      res.status(201).json({ token, user: { id: user._id, name: user.name, role: user.role, institutionId, email: user.email } });
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: "Registration failed. Please try again." });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    try {
      const user = await User.findOne({ email: email?.toLowerCase() });
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      const token = jwt.sign(
        { id: user._id, institutionId: user.institution_id, role: user.role },
        JWT_SECRET!,
        { expiresIn: "7d" }
      );
      res.json({ token, user: { id: user._id, name: user.name, role: user.role, institutionId: user.institution_id, email: user.email } });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Forgot Password
  app.post("/api/auth/forgot-password", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });
    try {
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user) return res.json({ message: "If that email exists, a reset link was sent" });

      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetExpiry = new Date(Date.now() + 60 * 60 * 1000);

      await User.findByIdAndUpdate(user._id, { resetToken, resetTokenExpiry: resetExpiry });

      const resetUrl = `${process.env.APP_URL || `http://localhost:${PORT}`}/reset-password?token=${resetToken}`;
      await sendEmail(
        email,
        'Reset Your Routify Password',
        `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <div style="background:#2563eb;padding:20px 24px;border-radius:16px 16px 0 0;">
            <h1 style="color:white;margin:0;font-size:22px">🔐 Password Reset</h1>
          </div>
          <div style="background:#f8fafc;padding:24px;border-radius:0 0 16px 16px;border:1px solid #e2e8f0">
            <h2 style="color:#1e293b;margin-top:0">Reset your Routify password</h2>
            <p style="color:#64748b">We received a request to reset the password for your account. Click the link below to set a new password. This link expires in <strong>1 hour</strong>.</p>
            <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin:16px 0">Reset Password →</a>
            <p style="color:#94a3b8;font-size:12px;margin-top:16px">If you didn't request this, you can safely ignore this email.<br>Powered by Routify</p>
          </div>
        </div>`
      );
      res.json({ message: "Reset link sent" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to send reset email" });
    }
  });

  // Reset Password
  app.post("/api/auth/reset-password", async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token and password are required" });
    try {
      const user = await User.findOne({
        resetToken: token,
        resetTokenExpiry: { $gt: new Date() }
      });
      if (!user) return res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });

      const hashedPassword = await bcrypt.hash(password, 10);
      await User.findByIdAndUpdate(user._id, {
        password: hashedPassword,
        resetToken: undefined,
        resetTokenExpiry: undefined
      });
      res.json({ message: "Password updated successfully" });
    } catch (error) {
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  // ─── Drivers API ─────────────────────────────────────────────────────────
  app.get("/api/drivers", authMiddleware, async (req: any, res) => {
    const drivers = await User.find({ institution_id: req.user.institutionId, role: 'driver' }).select('-password').sort('name');
    res.json(drivers);
  });

  app.post("/api/drivers", authMiddleware, async (req: any, res) => {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required" });
    try {
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) return res.status(409).json({ error: "Email already in use" });
      const id = uuidv4();
      const hashed = await bcrypt.hash(password, 10);
      const driver = await User.create({ _id: id, institution_id: req.user.institutionId, name, email: email.toLowerCase(), password: hashed, role: 'driver', phone: phone || undefined });
      res.status(201).json({ id: driver._id, name: driver.name, email: driver.email, phone: driver.phone, role: 'driver' });
    } catch (error) {
      res.status(500).json({ error: "Failed to add driver" });
    }
  });

  app.delete("/api/drivers/:id", authMiddleware, async (req: any, res) => {
    try {
      const result = await User.findOneAndDelete({ _id: req.params.id, institution_id: req.user.institutionId, role: 'driver' });
      if (!result) return res.status(404).json({ error: "Driver not found" });
      res.json({ message: "Driver deleted" });
    } catch { res.status(500).json({ error: "Failed to delete driver" }); }
  });

  // ─── Vehicles API ─────────────────────────────────────────────────────────
  app.get("/api/vehicles", authMiddleware, async (req: any, res) => {
    const vehicles = await Vehicle.find({ institution_id: req.user.institutionId }).sort('plate_number');
    res.json(vehicles);
  });

  app.post("/api/vehicles", authMiddleware, async (req: any, res) => {
    const { plate_number, model, capacity } = req.body;
    if (!plate_number) return res.status(400).json({ error: "Plate number is required" });
    try {
      const id = uuidv4();
      const vehicle = await Vehicle.create({ _id: id, institution_id: req.user.institutionId, plate_number: plate_number.toUpperCase(), model: model || undefined, capacity: capacity || undefined });
      res.status(201).json(vehicle);
    } catch { res.status(500).json({ error: "Failed to add vehicle" }); }
  });

  app.patch("/api/vehicles/:id", authMiddleware, async (req: any, res) => {
    try {
      const { status, driver_id } = req.body;
      const update: any = {};
      if (status) update.status = status;
      if (driver_id !== undefined) update.driver_id = driver_id;
      
      await Vehicle.findOneAndUpdate(
        { _id: req.params.id, institution_id: req.user.institutionId }, 
        update
      );
      res.json({ message: "Updated" });
    } catch { res.status(500).json({ error: "Failed to update" }); }
  });

  app.delete("/api/vehicles/:id", authMiddleware, async (req: any, res) => {
    try {
      await Vehicle.findOneAndDelete({ _id: req.params.id, institution_id: req.user.institutionId });
      res.json({ message: "Vehicle deleted" });
    } catch { res.status(500).json({ error: "Failed to delete" }); }
  });

  // ─── Routes API ───────────────────────────────────────────────────────────
  app.get("/api/routes", authMiddleware, async (req: any, res) => {
    const routes = await Route.find({ institution_id: req.user.institutionId }).sort('name');
    const routesWithCounts = await Promise.all(routes.map(async (r) => {
      const count = await Student.countDocuments({ route_id: r._id });
      return { ...r.toObject(), student_count: count };
    }));
    res.json(routesWithCounts);
  });

  app.post("/api/routes", authMiddleware, async (req: any, res) => {
    const { name, start_location, end_location } = req.body;
    if (!name) return res.status(400).json({ error: "Route name is required" });
    try {
      const id = uuidv4();
      const route = await Route.create({ _id: id, institution_id: req.user.institutionId, name, start_location: start_location || undefined, end_location: end_location || undefined });
      res.status(201).json({ ...route.toObject(), student_count: 0 });
    } catch { res.status(500).json({ error: "Failed to add route" }); }
  });

  app.patch("/api/routes/:id", authMiddleware, async (req: any, res) => {
    try {
      const { vehicle_id, name, start_location, end_location } = req.body;
      const update: any = {};
      if (vehicle_id !== undefined) update.vehicle_id = vehicle_id;
      if (name) update.name = name;
      if (start_location) update.start_location = start_location;
      if (end_location) update.end_location = end_location;

      await Route.findOneAndUpdate(
        { _id: req.params.id, institution_id: req.user.institutionId },
        update
      );
      res.json({ message: "Updated" });
    } catch { res.status(500).json({ error: "Failed to update route" }); }
  });

  app.delete("/api/routes/:id", authMiddleware, async (req: any, res) => {
    try {
      await Route.findOneAndDelete({ _id: req.params.id, institution_id: req.user.institutionId });
      await Student.updateMany({ route_id: req.params.id }, { route_id: null });
      res.json({ message: "Route deleted" });
    } catch { res.status(500).json({ error: "Failed to delete" }); }
  });

  // Save custom stop order for a route
  app.patch("/api/routes/:id/stop-order", authMiddleware, async (req: any, res) => {
    try {
      const { stop_order } = req.body;
      if (!Array.isArray(stop_order)) return res.status(400).json({ error: "stop_order must be an array" });
      await Route.findOneAndUpdate(
        { _id: req.params.id, institution_id: req.user.institutionId },
        { stop_order }
      );
      res.json({ message: "Stop order saved" });
    } catch { res.status(500).json({ error: "Failed to save stop order" }); }
  });

  // Get students for a specific route (for route map builder)
  app.get("/api/routes/:id/students", authMiddleware, async (req: any, res) => {
    try {
      const route = await Route.findOne({ _id: req.params.id, institution_id: req.user.institutionId });
      if (!route) return res.status(404).json({ error: "Route not found" });
      const students = await Student.find({
        route_id: req.params.id,
        institution_id: req.user.institutionId
      });
      res.json({ route, students });
    } catch { res.status(500).json({ error: "Failed to load route students" }); }
  });

  // ─── Students API ─────────────────────────────────────────────────────────
  app.get("/api/students", authMiddleware, async (req: any, res) => {
    const students = await Student.find({ institution_id: req.user.institutionId }).sort('name');
    const result = await Promise.all(students.map(async (s) => {
      let route_name = null;
      if (s.route_id) {
        const r = await Route.findById(s.route_id).select('name');
        route_name = r?.name || null;
      }
      return { ...s.toObject(), route_name };
    }));
    res.json(result);
  });

  app.post("/api/students", authMiddleware, async (req: any, res) => {
    const { name, parent_email, parent_phone, route_id, pickup_location } = req.body;
    if (!name || !parent_email) return res.status(400).json({ error: "Name and parent email are required" });
    try {
      const id = uuidv4();
      const access_token = uuidv4().replace(/-/g, '');
      
      let pickup_lat = undefined;
      let pickup_lng = undefined;

      if (pickup_location) {
        try {
          const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(pickup_location)}&format=json&limit=1`;
          const geoRes = await fetch(url, { headers: { 'User-Agent': 'Routify/1.0 (school transport app)' } });
          const geoData = await geoRes.json() as any[];
          if (geoData && geoData.length > 0) {
            pickup_lat = parseFloat(geoData[0].lat);
            pickup_lng = parseFloat(geoData[0].lon);
          }
        } catch (e) {
          console.error("Auto-geocoding failed for student creation:", e);
        }
      }

      const student = await Student.create({
        _id: id, institution_id: req.user.institutionId, route_id: route_id || undefined,
        name, parent_email, parent_phone: parent_phone || undefined,
        pickup_location: pickup_location || undefined, 
        pickup_lat, pickup_lng, access_token
      });

      const inst = await Institution.findById(req.user.institutionId);
      const portalUrl = `${process.env.APP_URL || `http://localhost:${PORT}`}/parent/portal/${access_token}`;
      await sendEmail(parent_email, `Your Routify Parent Portal — ${inst?.name || 'School'}`,
        `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <div style="background:#2563eb;padding:20px 24px;border-radius:16px 16px 0 0;">
            <h1 style="color:white;margin:0;font-size:24px">🚌 Routify</h1>
          </div>
          <div style="background:#f8fafc;padding:24px;border-radius:0 0 16px 16px;border:1px solid #e2e8f0">
            <h2 style="color:#1e293b;margin-top:0">Your child's bus tracker is ready!</h2>
            <p style="color:#64748b;line-height:1.6">${inst?.name || 'Your school'} has added <strong>${name}</strong> to their transport system. You can now track the bus in real-time on our live map.</p>
            
            <div style="background:#eff6ff;padding:20px;border-radius:12px;margin:24px 0;border-left:4px solid #2563eb">
              <h3 style="color:#1e40af;margin-top:0;font-size:16px">📍 Action Required: Pin Your Bus Stop</h3>
              <p style="color:#1e40af;font-size:14px;margin-bottom:16px">To ensure the bus stops at the correct spot and you get accurate arrival times, please open the portal and use the <strong>"Pin Your Stop"</strong> tool to mark your child's exact pickup location on the map.</p>
              <a href="${portalUrl}" style="display:inline-block;background:#2563eb;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700">Open Tracking Portal →</a>
            </div>

            <p style="color:#94a3b8;font-size:12px;margin-top:24px">If you didn't expect this email, please ignore it.<br>Powered by Routify</p>
          </div>
        </div>`
      ).catch(console.error);

      res.status(201).json({ ...student.toObject(), route_name: null });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to add student" });
    }
  });

  app.delete("/api/students/:id", authMiddleware, async (req: any, res) => {
    try {
      await Student.findOneAndDelete({ _id: req.params.id, institution_id: req.user.institutionId });
      res.json({ message: "Student deleted" });
    } catch { res.status(500).json({ error: "Failed to delete" }); }
  });

  // ─── Route Optimization (OSRM Free API) ─────────────────────────────────────
  app.get("/api/routes/:id/optimize", authMiddleware, async (req: any, res) => {
    try {
      const route = await Route.findOne({ _id: req.params.id, institution_id: req.user.institutionId });
      if (!route) return res.status(404).json({ error: "Route not found" });

      const students = await Student.find({
        route_id: req.params.id,
        institution_id: req.user.institutionId,
        pickup_lat: { $exists: true, $ne: null },
        pickup_lng: { $exists: true, $ne: null }
      });

      if (students.length < 2) {
        return res.json({ optimized: students, message: "Not enough geocoded stops to optimize" });
      }

      const coords = students.map(s => `${s.pickup_lng},${s.pickup_lat}`).join(';');
      const osrmUrl = `https://router.project-osrm.org/trip/v1/driving/${coords}?roundtrip=false&source=first&destination=last&steps=false&annotations=false&overview=full&geometries=geojson`;

      const osrmRes = await fetch(osrmUrl);
      const osrmData = await osrmRes.json() as any;

      if (osrmData.code !== 'Ok') {
        return res.json({ optimized: students, message: "OSRM optimization unavailable, showing original order" });
      }

      const waypointOrder: number[] = osrmData.trips?.[0]?.waypoints?.map((w: any) => w.waypoint_index) || [];
      const optimized = waypointOrder.map((idx: number) => students[idx]).filter(Boolean);

      res.json({
        optimized,
        geometry: osrmData.trips?.[0]?.geometry,
        duration_seconds: osrmData.trips?.[0]?.duration,
        distance_meters: osrmData.trips?.[0]?.distance,
        message: `Optimized ${optimized.length} stops — saves ~${Math.round((osrmData.trips?.[0]?.duration || 0) / 60)} min total drive time`
      });
    } catch (error) {
      console.error('Route optimization error:', error);
      res.status(500).json({ error: "Optimization failed" });
    }
  });

  // Geocode a student address (via Nominatim free API)
  app.post("/api/geocode", authMiddleware, async (req: any, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: "Address required" });
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
      const geoRes = await fetch(url, { headers: { 'User-Agent': 'Routify/1.0 (school transport app)' } });
      const geoData = await geoRes.json() as any[];
      if (!geoData || geoData.length === 0) return res.status(404).json({ error: "Address not found" });
      const { lat, lon, display_name } = geoData[0];
      res.json({ lat: parseFloat(lat), lng: parseFloat(lon), display_name });
    } catch {
      res.status(500).json({ error: "Geocoding failed" });
    }
  });

  // Update student geocoded location
  app.patch("/api/students/:id/location", authMiddleware, async (req: any, res) => {
    const { pickup_lat, pickup_lng } = req.body;
    try {
      await Student.findOneAndUpdate(
        { _id: req.params.id, institution_id: req.user.institutionId },
        { pickup_lat, pickup_lng }
      );
      res.json({ message: "Location updated" });
    } catch { res.status(500).json({ error: "Failed to update location" }); }
  });

  // ─── Dashboard Stats ──────────────────────────────────────────────────────
  app.get("/api/dashboard/stats", authMiddleware, async (req: any, res) => {
    const instId = req.user.institutionId;
    const [activeTrips, totalRoutes, totalDrivers, totalStudents, totalVehicles] = await Promise.all([
      Trip.countDocuments({ institution_id: instId, status: 'active' }),
      Route.countDocuments({ institution_id: instId }),
      User.countDocuments({ institution_id: instId, role: 'driver' }),
      Student.countDocuments({ institution_id: instId }),
      Vehicle.countDocuments({ institution_id: instId }),
    ]);
    res.json({ activeTrips, totalRoutes, totalDrivers, totalStudents, totalVehicles });
  });

  // Active Trips
  app.get("/api/trips/active", authMiddleware, async (req: any, res) => {
    const trips = await Trip.find({ institution_id: req.user.institutionId, status: 'active' });
    res.json(trips);
  });

  // ─── Trip History ─────────────────────────────────────────────────────────
  app.get("/api/trips/history", authMiddleware, async (req: any, res) => {
    try {
      const instId = req.user.institutionId;
      const { limit = 20, skip = 0 } = req.query;
      
      const trips = await Trip.find({ 
        institution_id: instId, 
        status: { $in: ['completed', 'cancelled'] } 
      })
        .sort({ ended_at: -1 })
        .limit(Number(limit))
        .skip(Number(skip));

      const tripsWithDetails = await Promise.all(trips.map(async (t) => {
        const driver = await User.findById(t.driver_id).select('name');
        const route = await Route.findById(t.route_id).select('name');
        const attendanceCounts = await TripAttendance.aggregate([
          { $match: { trip_id: t._id } },
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);
        const attendanceMap: any = {};
        attendanceCounts.forEach((a: any) => { attendanceMap[a._id] = a.count; });
        
        return {
          ...t.toObject(),
          driver_name: driver?.name || 'Unknown',
          route_name: route?.name || 'Unknown Route',
          picked_up: attendanceMap.picked_up || 0,
          dropped_off: attendanceMap.dropped_off || 0,
          absent: attendanceMap.absent || 0,
        };
      }));

      const total = await Trip.countDocuments({ institution_id: instId, status: { $in: ['completed', 'cancelled'] } });
      res.json({ trips: tripsWithDetails, total });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load trip history" });
    }
  });

  // ─── Attendance API ───────────────────────────────────────────────────────
  // Init attendance for a trip (called when trip starts)
  app.post("/api/trips/:tripId/attendance/init", authMiddleware, async (req: any, res) => {
    try {
      const { tripId } = req.params;
      const { route_id } = req.body;
      if (!route_id) return res.status(400).json({ error: "route_id required" });

      const students = await Student.find({
        route_id,
        institution_id: req.user.institutionId
      });

      // Upsert attendance records for each student
      await Promise.all(students.map(s =>
        TripAttendance.findOneAndUpdate(
          { trip_id: tripId, student_id: s._id },
          { 
            _id: uuidv4(),
            trip_id: tripId,
            institution_id: req.user.institutionId,
            student_id: s._id,
            status: 'pending',
            updated_at: new Date()
          },
          { upsert: true, new: true }
        )
      ));

      res.json({ message: `Attendance initialised for ${students.length} students` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to init attendance" });
    }
  });

  // Get attendance for a trip
  app.get("/api/trips/:tripId/attendance", authMiddleware, async (req: any, res) => {
    try {
      const records = await TripAttendance.find({ trip_id: req.params.tripId, institution_id: req.user.institutionId });
      const withStudents = await Promise.all(records.map(async (r) => {
        const student = await Student.findById(r.student_id).select('name pickup_location');
        return { ...r.toObject(), student_name: student?.name, pickup_location: student?.pickup_location };
      }));
      res.json(withStudents);
    } catch { res.status(500).json({ error: "Failed to load attendance" }); }
  });

  // Update attendance status for a student
  app.patch("/api/trips/:tripId/attendance/:studentId", authMiddleware, async (req: any, res) => {
    try {
      const { status } = req.body;
      const validStatuses = ['pending', 'picked_up', 'dropped_off', 'absent'];
      if (!validStatuses.includes(status)) return res.status(400).json({ error: "Invalid status" });

      const record = await TripAttendance.findOneAndUpdate(
        { trip_id: req.params.tripId, student_id: req.params.studentId, institution_id: req.user.institutionId },
        { status, updated_at: new Date() },
        { new: true }
      );

      if (!record) return res.status(404).json({ error: "Attendance record not found" });

      // Feature 2: Send parent notification email
      if (status === 'picked_up' || status === 'dropped_off') {
        const student = await Student.findById(req.params.studentId);
        const inst = await Institution.findById(req.user.institutionId);
        if (student && student.parent_email) {
          const isPickup = status === 'picked_up';
          const emoji = isPickup ? '🚌' : '🏠';
          const action = isPickup ? 'has been picked up and is on the bus' : 'has been dropped off safely';
          const subject = isPickup
            ? `${student.name} is on the bus — ${inst?.name || 'School'}`
            : `${student.name} has been dropped off — ${inst?.name || 'School'}`;

          sendEmail(student.parent_email, subject,
            `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px">
              <div style="background:${isPickup ? '#2563eb' : '#16a34a'};padding:20px 24px;border-radius:16px 16px 0 0;">
                <h1 style="color:white;margin:0;font-size:24px">${emoji} Routify Transport Alert</h1>
              </div>
              <div style="background:#f8fafc;padding:24px;border-radius:0 0 16px 16px;border:1px solid #e2e8f0">
                <h2 style="color:#1e293b;margin-top:0">${emoji} ${isPickup ? 'Your child is on the bus!' : 'Your child has arrived safely!'}</h2>
                <p style="color:#64748b;line-height:1.6;font-size:16px"><strong>${student.name}</strong> ${action}.</p>
                <div style="background:${isPickup ? '#eff6ff' : '#f0fdf4'};padding:16px;border-radius:12px;margin:16px 0;border-left:4px solid ${isPickup ? '#2563eb' : '#16a34a'}">
                  <p style="margin:0;color:${isPickup ? '#1e40af' : '#166534'};font-size:14px">
                    <strong>Time:</strong> ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}<br>
                    <strong>Status:</strong> ${isPickup ? 'On Bus 🚌' : 'Dropped Off ✅'}
                  </p>
                </div>
                <p style="color:#94a3b8;font-size:12px;margin-top:24px">Powered by Routify — ${inst?.name || 'School Transport'}</p>
              </div>
            </div>`
          ).catch(console.error);
        }
      }

      res.json({ message: "Attendance updated", record });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update attendance" });
    }
  });

  // ─── Notices API ─────────────────────────────────────────────────────────
  app.get("/api/notices", authMiddleware, async (req: any, res) => {
    try {
      const now = new Date();
      const notices = await Notice.find({
        institution_id: req.user.institutionId,
        active: true,
        $or: [{ expires_at: null }, { expires_at: { $gt: now } }]
      }).sort({ createdAt: -1 });
      res.json(notices);
    } catch { res.status(500).json({ error: "Failed to load notices" }); }
  });

  app.post("/api/notices", authMiddleware, async (req: any, res) => {
    try {
      const { title, message, expires_at } = req.body;
      if (!title || !message) return res.status(400).json({ error: "Title and message are required" });
      const notice = await Notice.create({
        _id: uuidv4(),
        institution_id: req.user.institutionId,
        title,
        message,
        active: true,
        expires_at: expires_at ? new Date(expires_at) : undefined
      });
      res.status(201).json(notice);
    } catch { res.status(500).json({ error: "Failed to create notice" }); }
  });

  app.delete("/api/notices/:id", authMiddleware, async (req: any, res) => {
    try {
      await Notice.findOneAndUpdate(
        { _id: req.params.id, institution_id: req.user.institutionId },
        { active: false }
      );
      res.json({ message: "Notice dismissed" });
    } catch { res.status(500).json({ error: "Failed to dismiss notice" }); }
  });

  // ─── Parent Portal Notices ────────────────────────────────────────────────
  app.get("/api/parent/:token/notices", async (req, res) => {
    try {
      const student = await Student.findOne({ access_token: req.params.token });
      if (!student) return res.status(404).json({ error: "Invalid token" });
      const now = new Date();
      const notices = await Notice.find({
        institution_id: student.institution_id,
        active: true,
        $or: [{ expires_at: null }, { expires_at: { $gt: now } }]
      }).sort({ createdAt: -1 }).limit(5);
      res.json(notices);
    } catch { res.status(500).json({ error: "Failed to load notices" }); }
  });

  // ─── Parent portal by token ───────────────────────────────────────────────
  app.get("/api/parent/:token", async (req, res) => {
    const student = await Student.findOne({ access_token: req.params.token });
    if (!student) return res.status(404).json({ error: "Invalid portal link" });

    const inst = await Institution.findById(student.institution_id);
    let route_name = null;
    if (student.route_id) {
      const r = await Route.findById(student.route_id);
      route_name = r?.name || null;
    }

    const trip = student.route_id
      ? await Trip.findOne({ route_id: student.route_id, status: 'active' })
          .populate('driver_id', 'name')
          .populate('vehicle_id', 'plate_number model')
      : null;

    // Get attendance status for this student in active trip
    let attendanceStatus = null;
    if (trip) {
      const att = await TripAttendance.findOne({ trip_id: trip._id, student_id: student._id });
      attendanceStatus = att?.status || null;
    }

    res.json({
      student: { ...student.toObject(), school_name: inst?.name, route_name },
      trip: trip ? {
        ...trip.toObject(),
        driver_name: (trip.driver_id as any)?.name,
        bus_name: (trip.vehicle_id as any)?.plate_number,
        model: (trip.vehicle_id as any)?.model,
      } : null,
      attendance_status: attendanceStatus
    });
  });

  // ─── Email Test ───────────────────────────────────────────────────────────
  app.get("/api/test-email", async (req, res) => {
    try {
      await sendEmail("bhapeestudios@gmail.com", "Routify System Test", "<h1>Mail System Working</h1>");
      res.json({ message: "Test email sent" });
    } catch { res.status(500).json({ error: "Email failed" }); }
  });

  // ─── Super Admin API ──────────────────────────────────────────────────────

  // Super Admin Login
  app.post("/api/superadmin/login", async (req, res) => {
    const { email, password } = req.body;
    const SA_EMAIL = process.env.SUPERADMIN_EMAIL;
    const SA_PASSWORD = process.env.SUPERADMIN_PASSWORD;

    if (!SA_EMAIL || !SA_PASSWORD) {
      return res.status(500).json({ error: "Super admin credentials not configured" });
    }
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    if (email.toLowerCase() !== SA_EMAIL.toLowerCase() || password !== SA_PASSWORD) {
      return res.status(401).json({ error: "Invalid super admin credentials" });
    }

    const token = jwt.sign(
      { role: 'superadmin', email: SA_EMAIL },
      JWT_SECRET!,
      { expiresIn: '24h' }
    );
    res.json({ token, email: SA_EMAIL, role: 'superadmin' });
  });

  // Super Admin: Platform Stats
  app.get("/api/superadmin/stats", superAdminMiddleware, async (req: any, res) => {
    try {
      const [totalInstitutions, totalStudents, totalDrivers, totalVehicles, totalRoutes,
             totalTrips, completedTrips, activeTrips, totalNotices, totalAttendance] = await Promise.all([
        Institution.countDocuments(),
        Student.countDocuments(),
        User.countDocuments({ role: 'driver' }),
        Vehicle.countDocuments(),
        Route.countDocuments(),
        Trip.countDocuments(),
        Trip.countDocuments({ status: 'completed' }),
        Trip.countDocuments({ status: 'active' }),
        Notice.countDocuments(),
        TripAttendance.countDocuments(),
      ]);
      res.json({ totalInstitutions, totalStudents, totalDrivers, totalVehicles,
                 totalRoutes, totalTrips, completedTrips, activeTrips, totalNotices, totalAttendance });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load stats" });
    }
  });

  // Super Admin: System Health
  app.get("/api/superadmin/health", superAdminMiddleware, async (req: any, res) => {
    const mongoose = (await import('mongoose')).default;
    const mongoState = mongoose.connection.readyState;
    const mongoStatus: Record<number, string> = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
    res.json({
      mongodb: mongoStatus[mongoState] || 'unknown',
      uptimeSeconds: process.uptime(),
      nodeVersion: process.version,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
    });
  });

  // Super Admin: List all institutions (with aggregated stats)
  app.get("/api/superadmin/institutions", superAdminMiddleware, async (req: any, res) => {
    try {
      const { limit } = req.query;
      let query = Institution.find().sort({ createdAt: -1 });
      if (limit) query = query.limit(Number(limit)) as any;
      const institutions = await query;

      const enriched = await Promise.all(institutions.map(async (inst) => {
        const [studentCount, driverCount, vehicleCount, routeCount] = await Promise.all([
          Student.countDocuments({ institution_id: inst._id }),
          User.countDocuments({ institution_id: inst._id, role: 'driver' }),
          Vehicle.countDocuments({ institution_id: inst._id }),
          Route.countDocuments({ institution_id: inst._id }),
        ]);
        return { ...inst.toObject(), studentCount, driverCount, vehicleCount, routeCount };
      }));

      res.json({ institutions: enriched, total: await Institution.countDocuments() });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load institutions" });
    }
  });

  // Super Admin: Get single institution with full stats
  app.get("/api/superadmin/institutions/:id", superAdminMiddleware, async (req: any, res) => {
    try {
      const inst = await Institution.findById(req.params.id);
      if (!inst) return res.status(404).json({ error: "Institution not found" });

      const [students, drivers, vehicles, routes, trips, activeTrips] = await Promise.all([
        Student.countDocuments({ institution_id: inst._id }),
        User.countDocuments({ institution_id: inst._id, role: 'driver' }),
        Vehicle.countDocuments({ institution_id: inst._id }),
        Route.countDocuments({ institution_id: inst._id }),
        Trip.countDocuments({ institution_id: inst._id }),
        Trip.countDocuments({ institution_id: inst._id, status: 'active' }),
      ]);

      res.json({
        institution: inst,
        stats: { students, drivers, vehicles, routes, trips, activeTrips }
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to load institution" });
    }
  });

  // Super Admin: Create institution (with admin user)
  app.post("/api/superadmin/institutions", superAdminMiddleware, async (req: any, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    try {
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) return res.status(409).json({ error: "An account with this email already exists" });

      const institutionId = uuidv4();
      const adminId = uuidv4();
      const hashed = await bcrypt.hash(password, 10);

      await Institution.create({ _id: institutionId, name, email: email.toLowerCase() });
      const adminUser = await User.create({
        _id: adminId,
        institution_id: institutionId,
        name,
        email: email.toLowerCase(),
        password: hashed,
        role: 'admin'
      });

      res.status(201).json({
        message: "Institution created",
        institution: { id: institutionId, name, email: email.toLowerCase() },
        admin: { id: adminUser._id, email: adminUser.email, role: 'admin' }
      });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: "Failed to create institution" });
    }
  });

  // Super Admin: Delete institution (cascade all data)
  app.delete("/api/superadmin/institutions/:id", superAdminMiddleware, async (req: any, res) => {
    try {
      const inst = await Institution.findById(req.params.id);
      if (!inst) return res.status(404).json({ error: "Institution not found" });

      // Cascade delete all related data
      const tripIds = (await Trip.find({ institution_id: req.params.id }).select('_id')).map(t => t._id);
      await Promise.all([
        TripAttendance.deleteMany({ institution_id: req.params.id }),
        Trip.deleteMany({ institution_id: req.params.id }),
        Student.deleteMany({ institution_id: req.params.id }),
        Route.deleteMany({ institution_id: req.params.id }),
        Vehicle.deleteMany({ institution_id: req.params.id }),
        Notice.deleteMany({ institution_id: req.params.id }),
        User.deleteMany({ institution_id: req.params.id }),
        Institution.findByIdAndDelete(req.params.id),
      ]);

      res.json({ message: `Institution "${inst.name}" and all data deleted permanently` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete institution" });
    }
  });


  // ─── Frontend Routes ──────────────────────────────────────────────────────
  app.get("/forgot-password", (req, res) => res.render("forgot-password", { title: "Forgot Password | Routify" }));
  app.get("/reset-password", (req, res) => res.render("reset-password", { title: "Reset Password | Routify" }));
  app.get("/", (req, res) => res.render("index", { title: "Routify — Smart School Transport, Zero Hardware" }));
  app.get("/login", (req, res) => res.render("login", { title: "Sign In | Routify" }));
  app.get("/register", (req, res) => res.render("register", { title: "Get Started Free | Routify" }));
  app.get("/admin/dashboard", (req, res) => res.render("admin/dashboard", { title: "Dashboard | Routify" }));
  app.get("/admin/routes", (req, res) => res.render("admin/routes", { title: "Routes | Routify" }));
  app.get("/admin/drivers", (req, res) => res.render("admin/drivers", { title: "Drivers | Routify" }));
  app.get("/admin/students", (req, res) => res.render("admin/students", { title: "Students | Routify" }));
  app.get("/admin/vehicles", (req, res) => res.render("admin/vehicles", { title: "Vehicles | Routify" }));
  app.get("/driver/app", (req, res) => res.render("driver/app", { title: "Driver App | Routify" }));
  app.get("/parent/portal/:token", (req, res) => res.render("parent/portal", { title: "Parent Portal | Routify", token: req.params.token }));
  app.get("/superadmin", (req, res) => res.redirect("/superadmin/login"));
  app.get("/superadmin/login", (req, res) => res.render("superadmin/login", { title: "Super Admin Login | Routify" }));
  app.get("/superadmin/dashboard", (req, res) => res.render("superadmin/dashboard", { title: "Command Center | Routify Super Admin" }));
  app.get("/superadmin/clients", (req, res) => res.render("superadmin/clients", { title: "Institutions | Routify Super Admin" }));
  app.get("/superadmin/system-health", (req, res) => res.render("superadmin/system-health", { title: "System Health | Routify Super Admin" }));
  app.get("/superadmin/analytics", (req, res) => res.render("superadmin/analytics", { title: "Analytics | Routify Super Admin" }));

  // ─── 404 Handler ──────────────────────────────────────────────────────────
  app.use((req: any, res: any) => {
    if (req.accepts('html')) {
      res.status(404).redirect('/');
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });

  // ─── Vite ─────────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "custom" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚌 Routify running at http://localhost:${PORT}\n`);
  });
}

startServer().catch(console.error);
