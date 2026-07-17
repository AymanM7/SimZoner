-- SimZoner seed data. Values and tags come from docs/VEHICLE_SPECS.md (see its §9
-- source index). Real parameters, synthetic outcomes. Nothing here is invented to
-- look complete; genuine gaps are tagged UNPUBLISHED with NULL sources.

-- ── VEHICLES (normalized, physics-ready) ───────────────────────────────────────
-- BMW M5 (G90): the only vehicle with manufacturer-published Cd AND frontal area
-- (VEHICLE_SPECS §2 resolved M5 over M3 — the M3 sheet omits exactly cd·A). HIGH.
INSERT INTO vehicles VALUES
 ('bmw-m5-g90', 'BMW M5', 'G90', 'PHEV V8',
  2435, 'DIN', 0.32, 2.55, 0.816, 535, 1000, 'M xDrive AWD', NULL, 0, 'HIGH',
  'Both aero terms manufacturer-verified. All figures preliminary ("vorläufige Werte").');

-- Tesla Cybertruck Cyberbeast: ZERO verified params; tesla.com returns HTTP 403.
-- Frontal area estimated from BODY width (track unpublished), biasing drag high. LOW.
INSERT INTO vehicles VALUES
 ('cybertruck-cyberbeast', 'Tesla Cybertruck', 'Cyberbeast (tri-motor)', 'tri-motor EV',
  3104, 'US-curb', 0.335, 3.06, 1.025, 622, 1390, 'Tri-motor AWD', NULL, 0, 'LOW',
  'No manufacturer source. Cd secondary; frontal area estimated from body-width proxy. Weakest-sourced entrant.');

-- Waymo = Jaguar I-Pace EV400. Cd verified by JLR; area estimated. Mass normalized
-- from the only published figure (EU kerb 2208, incl. 75 kg driver) to a DIN-equiv
-- ESTIMATE of 2133 (VEHICLE_SPECS §6). Sensor pod penalty UNPUBLISHED → 0: a Waymo
-- result is really a base-I-Pace result (VEHICLE_SPECS §5b). MEDIUM.
INSERT INTO vehicles VALUES
 ('waymo-ipace', 'Waymo (Jaguar I-Pace)', 'EV400 + sensor suite', 'twin-motor EV',
  2133, 'DIN-equiv (est)', 0.29, 2.16, 0.6264, 294, 694, 'AWD twin-motor', NULL, 0, 'MEDIUM',
  'Base I-Pace. Sensor mass/drag genuinely unpublished; modeled configuration != Waymo configuration.');

-- ── PROVENANCE LEDGER ──────────────────────────────────────────────────────────
-- BMW M5 — manufacturer PDF T0443252DE/621213
INSERT INTO vehicle_params VALUES
 ('bmw-m5-g90','cd','0.32',NULL,'VERIFIED','https://www.press.bmwgroup.com/deutschland/article/attachment/T0443252DE/621213','Luftwiderstand cX x A = 0,32 x 2,55'),
 ('bmw-m5-g90','frontal_area_m2','2.55','m^2','VERIFIED','https://www.press.bmwgroup.com/deutschland/article/attachment/T0443252DE/621213','Matched pair with Cd on one line'),
 ('bmw-m5-g90','mass_kg','2435','kg','VERIFIED','https://www.press.bmwgroup.com/deutschland/article/attachment/T0443252DE/621213','DIN (driverless)'),
 ('bmw-m5-g90','power_kw','535','kW','VERIFIED','https://www.press.bmwgroup.com/deutschland/article/attachment/T0443252DE/621213','Systemleistung'),
 ('bmw-m5-g90','torque_nm','1000','Nm','VERIFIED','https://www.press.bmwgroup.com/deutschland/article/attachment/T0443252DE/621213','Systemdrehmoment'),
 ('bmw-m5-g90','crr',NULL,NULL,'UNPUBLISHED',NULL,'Not published for any of the three');

-- Cybertruck — secondary (evspecs) + confirmed-blocked primary
INSERT INTO vehicle_params VALUES
 ('cybertruck-cyberbeast','cd','0.335',NULL,'SECONDARY','https://www.evspecs.org/tech-specs/tesla/cybertruck/cyberbeast','Consistently reported; not primary-confirmed'),
 ('cybertruck-cyberbeast','frontal_area_m2','3.06','m^2','ESTIMATED',NULL,'0.84 x body_width(2.032) x height(1.791); track unpublished, so body width proxied — biases high'),
 ('cybertruck-cyberbeast','mass_kg','3104','kg','SECONDARY','https://www.evspecs.org/tech-specs/tesla/cybertruck/cyberbeast','US curb (driverless)'),
 ('cybertruck-cyberbeast','power_kw','622','kW','SECONDARY','https://www.evspecs.org/tech-specs/tesla/cybertruck/cyberbeast','Sources vary 834-845 hp'),
 ('cybertruck-cyberbeast','torque_nm','1390','Nm','SECONDARY','https://www.evspecs.org/tech-specs/tesla/cybertruck/cyberbeast',NULL),
 ('cybertruck-cyberbeast','track_width',NULL,NULL,'UNPUBLISHED',NULL,'Blocks a proper frontal-area estimate'),
 ('cybertruck-cyberbeast','primary_source',NULL,NULL,'UNPUBLISHED','https://www.tesla.com/cybertruck/specs','HTTP 403 to automated fetch — confirmed firsthand'),
 ('cybertruck-cyberbeast','crr',NULL,NULL,'UNPUBLISHED',NULL,'All-terrain tires likely raise it — unmodeled bias');

-- Jaguar I-Pace / Waymo
INSERT INTO vehicle_params VALUES
 ('waymo-ipace','cd','0.29',NULL,'VERIFIED','https://media.jaguarlandrover.com/en-us/news/2018/03/2019-jaguar-i-pace','JLR: "a drag coefficient of just 0.29Cd"'),
 ('waymo-ipace','frontal_area_m2','2.16','m^2','ESTIMATED',NULL,'0.84 x track_front(1.644) x height(1.565); formula under-estimates for crossovers'),
 ('waymo-ipace','mass_kg','2133','kg','ESTIMATED','https://www.evspecs.org/tech-specs/jaguar/i-pace/ev400','EU kerb 2208 (incl. 75kg driver) minus 75 → DIN-equiv'),
 ('waymo-ipace','power_kw','294','kW','VERIFIED','https://media.jaguarlandrover.com/en-us/news/2018/03/2019-jaguar-i-pace',NULL),
 ('waymo-ipace','torque_nm','694','Nm','ESTIMATED','https://media.jaguarlandrover.com/en-us/news/2018/03/2019-jaguar-i-pace','512 lb-ft x 1.35582'),
 ('waymo-ipace','sensor_penalty',NULL,NULL,'UNPUBLISHED',NULL,'Waymo pod mass + drag delta never published'),
 ('waymo-ipace','crr',NULL,NULL,'UNPUBLISHED',NULL,'Not published for any of the three');

-- ── SAMPLE ROUTE: I-45 Houston → Galveston (SIMULATION_RULES §3) ────────────────
-- The real HOV facility ends at Webster, so it runs out mid-route (seg 2 onward = 0
-- HOV lanes). Coastal plain → grade ~0. Causeway speed limit genuinely unsourced.
INSERT INTO routes VALUES
 ('i45-houston-galveston', 'I-45 Gulf Freeway — Houston to Galveston', 80.0,
  'HOV ends at Webster (seg 2). Flat coastal plain. Causeway limit unverified.');

INSERT INTO route_segments VALUES
 ('i45-houston-galveston',0,'Downtown Houston on-ramp',        6.0, 5, 1, 60, 1, 0.0, 0.7,'Dense urban start'),
 ('i45-houston-galveston',1,'South Houston / Gulf Fwy',       18.0, 4, 1, 65, 1, 0.0, 0.5,'HOV still present'),
 ('i45-houston-galveston',2,'Webster — HOV ENDS',             12.0, 4, 0, 65, 1, 0.0, 0.4,'Forced re-merge; HOV strategy evaporates'),
 ('i45-houston-galveston',3,'Dickinson / League City',        22.0, 3, 0, 65, 1, 0.0, 0.3,'Open suburban'),
 ('i45-houston-galveston',4,'Galveston Causeway',              8.0, 3, 0, 60, 0, 0.0, 0.2,'Over water; speed limit UNVERIFIED'),
 ('i45-houston-galveston',5,'Galveston Island arrival',       14.0, 2, 0, 45, 1, 0.0, 0.6,'Island streets, lower limit');

-- ── ROUTE: I-35 South → Austin (SIMULATION_RULES §3) ───────────────────────────
-- The Capital Express South project adds HOV lanes but they are UNDER CONSTRUCTION,
-- so hov_lanes = 0 today (modeled "as-is", not "as-planned"). The notorious
-- Buda / San Marcos congestion is the defining feature. Rolling terrain → small grades.
INSERT INTO routes VALUES
 ('i35-south-austin', 'I-35 South — San Antonio side to Austin', 70.0,
  'HOV under construction (Capital Express South) → modeled as 0 today. Buda/San Marcos congestion. Rolling grades.');

INSERT INTO route_segments VALUES
 ('i35-south-austin',0,'New Braunfels approach',    16.0, 3, 0, 70, 1, 1.5, 0.4,'Rolling hill country'),
 ('i35-south-austin',1,'San Marcos',                14.0, 3, 0, 65, 1, 2.0, 0.6,'University-town congestion'),
 ('i35-south-austin',2,'Buda bottleneck',           12.0, 2, 0, 60, 1, 1.0, 0.8,'Notorious congestion; lane drop'),
 ('i35-south-austin',3,'South Austin / Slaughter',  16.0, 4, 0, 65, 1, 1.5, 0.6,'Widening back out'),
 ('i35-south-austin',4,'Downtown Austin arrival',   12.0, 4, 0, 55, 1, 0.5, 0.7,'Lower-tier limit, dense');

-- ── ROUTE: Chicago — I-90/94 Kennedy Expressway (SIMULATION_RULES §3) ───────────
-- No occupancy-based HOV. The Kennedy's reversible express lanes are DIRECTION-gated,
-- not occupancy-gated — modeled as normal lanes (hov_lanes = 0). Dense urban, flat.
INSERT INTO routes VALUES
 ('chicago-kennedy', 'Chicago — I-90/94 Kennedy Expressway', 30.0,
  'No occupancy HOV; reversible express lanes are direction-gated. Flat, dense urban.');

INSERT INTO route_segments VALUES
 ('chicago-kennedy',0,'O''Hare approach',     10.0, 5, 0, 55, 1, 0.0, 0.7,'Airport traffic'),
 ('chicago-kennedy',1,'Kennedy mid (Jane Byrne)', 12.0, 4, 0, 45, 1, 0.0, 0.9,'Interchange chokepoint'),
 ('chicago-kennedy',2,'Downtown Loop arrival',  8.0, 4, 0, 45, 1, 0.0, 0.8,'Dense core');

-- ── ROUTE: Cincinnati — I-71/75 (SIMULATION_RULES §3, the CONTROL group) ─────────
-- No HOV lanes anywhere. Serves as the control that isolates the value of lane access:
-- with no HOV to contest, outcomes here are pure physics + traffic. Ohio River grades.
INSERT INTO routes VALUES
 ('cincinnati-i71-75', 'Cincinnati — I-71/75 Brent Spence corridor', 25.0,
  'No HOV at all — control route. Ohio River valley grades near the bridge.');

INSERT INTO route_segments VALUES
 ('cincinnati-i71-75',0,'Northern Kentucky approach', 9.0, 4, 0, 65, 1, 2.5, 0.5,'Descent toward river'),
 ('cincinnati-i71-75',1,'Brent Spence Bridge',        6.0, 3, 0, 55, 1, 1.0, 0.8,'Bottleneck bridge over Ohio River'),
 ('cincinnati-i71-75',2,'Downtown Cincinnati',       10.0, 4, 0, 65, 1, 2.0, 0.5,'Climb out of valley');
