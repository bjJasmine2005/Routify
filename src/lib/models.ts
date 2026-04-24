import mongoose, { Schema, Document, Model } from 'mongoose';

// ─── Institution ─────────────────────────────────────────────────────────────
export interface IInstitution {
  _id: string;
  name: string;
  email: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const InstitutionSchema = new Schema<IInstitution>({
  _id: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
}, { timestamps: true });

// ─── User ─────────────────────────────────────────────────────────────────────
export interface IUser {
  _id: string;
  institution_id: string;
  name: string;
  email: string;
  password: string;
  role: 'admin' | 'driver';
  phone?: string;
  resetToken?: string;
  resetTokenExpiry?: Date;
  resetPasswordToken?: string;
  resetPasswordExpire?: Date;
}

const UserSchema = new Schema<IUser>({
  _id: { type: String, required: true },
  institution_id: { type: String, required: true, index: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'driver'], required: true },
  phone: { type: String },
  resetToken: { type: String },
  resetTokenExpiry: { type: Date },
  resetPasswordToken: { type: String },
  resetPasswordExpire: { type: Date },
});

// ─── Vehicle ──────────────────────────────────────────────────────────────────
export interface IVehicle {
  _id: string;
  institution_id: string;
  plate_number: string;
  model?: string;
  capacity?: number;
  status: 'active' | 'maintenance' | 'inactive';
  driver_id?: string;
}

const VehicleSchema = new Schema<IVehicle>({
  _id: { type: String, required: true },
  institution_id: { type: String, required: true, index: true },
  plate_number: { type: String, required: true },
  model: { type: String },
  capacity: { type: Number },
  status: { type: String, enum: ['active', 'maintenance', 'inactive'], default: 'active' },
  driver_id: { type: String, default: null, index: true },
});

// ─── Route ────────────────────────────────────────────────────────────────────
export interface IRoute {
  _id: string;
  institution_id: string;
  name: string;
  start_location?: string;
  end_location?: string;
  vehicle_id?: string;
  stop_order?: string[]; // Array of student IDs in pickup order
}

const RouteSchema = new Schema<IRoute>({
  _id: { type: String, required: true },
  institution_id: { type: String, required: true, index: true },
  name: { type: String, required: true },
  start_location: { type: String },
  end_location: { type: String },
  vehicle_id: { type: String, default: null, index: true },
  stop_order: { type: [String], default: [] },
});

// ─── Student ──────────────────────────────────────────────────────────────────
export interface IStudent {
  _id: string;
  institution_id: string;
  route_id?: string;
  name: string;
  parent_email: string;
  parent_phone?: string;
  pickup_location?: string;
  pickup_lat?: number;
  pickup_lng?: number;
  access_token: string;
}

const StudentSchema = new Schema<IStudent>({
  _id: { type: String, required: true },
  institution_id: { type: String, required: true, index: true },
  route_id: { type: String, default: null },
  name: { type: String, required: true },
  parent_email: { type: String, required: true },
  parent_phone: { type: String },
  pickup_location: { type: String },
  pickup_lat: { type: Number },
  pickup_lng: { type: Number },
  access_token: { type: String, unique: true },
});

// ─── Trip ─────────────────────────────────────────────────────────────────────
export interface ITrip {
  _id: string;
  institution_id: string;
  route_id: string;
  driver_id: string;
  vehicle_id: string;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  current_lat?: number;
  current_lng?: number;
  started_at?: Date;
  ended_at?: Date;
  distance_meters?: number;
  duration_seconds?: number;
}

const TripSchema = new Schema<ITrip>({
  _id: { type: String, required: true },
  institution_id: { type: String, required: true, index: true },
  route_id: { type: String, required: true },
  driver_id: { type: String, required: true },
  vehicle_id: { type: String, required: true },
  status: { type: String, enum: ['scheduled', 'active', 'completed', 'cancelled'], default: 'scheduled' },
  current_lat: { type: Number },
  current_lng: { type: Number },
  started_at: { type: Date },
  ended_at: { type: Date },
  distance_meters: { type: Number },
  duration_seconds: { type: Number },
}, { timestamps: true });

// ─── TripAttendance ───────────────────────────────────────────────────────────
export interface ITripAttendance {
  _id: string;
  trip_id: string;
  institution_id: string;
  student_id: string;
  status: 'pending' | 'picked_up' | 'dropped_off' | 'absent';
  updated_at?: Date;
}

const TripAttendanceSchema = new Schema<ITripAttendance>({
  _id: { type: String, required: true },
  trip_id: { type: String, required: true, index: true },
  institution_id: { type: String, required: true, index: true },
  student_id: { type: String, required: true },
  status: { type: String, enum: ['pending', 'picked_up', 'dropped_off', 'absent'], default: 'pending' },
  updated_at: { type: Date, default: Date.now },
});

// ─── Notice ───────────────────────────────────────────────────────────────────
export interface INotice {
  _id: string;
  institution_id: string;
  title: string;
  message: string;
  active: boolean;
  expires_at?: Date;
  createdAt?: Date;
}

const NoticeSchema = new Schema<INotice>({
  _id: { type: String, required: true },
  institution_id: { type: String, required: true, index: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  active: { type: Boolean, default: true },
  expires_at: { type: Date },
}, { timestamps: true });

// ─── Exports ──────────────────────────────────────────────────────────────────
export const Institution: Model<IInstitution> = mongoose.models.Institution || mongoose.model<IInstitution>('Institution', InstitutionSchema);
export const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
export const Vehicle: Model<IVehicle> = mongoose.models.Vehicle || mongoose.model<IVehicle>('Vehicle', VehicleSchema);
export const Route: Model<IRoute> = mongoose.models.Route || mongoose.model<IRoute>('Route', RouteSchema);
export const Student: Model<IStudent> = mongoose.models.Student || mongoose.model<IStudent>('Student', StudentSchema);
export const Trip: Model<ITrip> = mongoose.models.Trip || mongoose.model<ITrip>('Trip', TripSchema);
export const TripAttendance: Model<ITripAttendance> = mongoose.models.TripAttendance || mongoose.model<ITripAttendance>('TripAttendance', TripAttendanceSchema);
export const Notice: Model<INotice> = mongoose.models.Notice || mongoose.model<INotice>('Notice', NoticeSchema);
