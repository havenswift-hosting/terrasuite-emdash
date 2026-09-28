// Put photographs on the demo stock.
//
// An agency uploads its own through the media library. This is for the demo
// site and for anybody evaluating the template, who should see what a property
// card looks like with a picture on it rather than a coloured panel.
//
// The pictures are the ones TerraSuite ships in its regional content packs:
// Unsplash and Pexels licences, free for commercial use, no attribution
// required. Point --from at a folder of JPEGs.
//
// Two things happen per file: a row in media, and the file under the storage
// directory at the key that row names. EmDash's local storage adapter maps a
// storage key straight onto the URL after /_emdash/api/media/file/, so the key
// is the path and nothing else has to agree.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const from = arg("from", "./demo-photos");
const db = new DatabaseSync(arg("db", "./data.db"));
const uploads = arg("uploads", "./uploads");
const prefix = "demo";

if (!existsSync(from)) {
	console.error(`No such folder: ${from}`);
	process.exit(1);
}

// Crockford base32, twenty-six characters, time then randomness: a ULID, which
// is what EmDash gives its own rows.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () => {
	let time = Date.now();
	let out = "";
	for (let i = 9; i >= 0; i -= 1) {
		out = CROCKFORD[time % 32] + out;
		time = Math.floor(time / 32);
	}
	for (let i = 0; i < 16; i += 1) out += CROCKFORD[Math.floor(Math.random() * 32)];
	return out;
};

/** Width and height straight out of the JPEG or PNG header. */
function dimensions(file) {
	const d = readFileSync(file);

	if (d[0] === 0x89 && d[1] === 0x50) {
		return { width: d.readUInt32BE(16), height: d.readUInt32BE(20), mime: "image/png" };
	}

	if (d[0] === 0xff && d[1] === 0xd8) {
		let i = 2;
		while (i < d.length - 9) {
			if (d[i] !== 0xff) { i += 1; continue; }
			const marker = d[i + 1];
			if (marker >= 0xc0 && marker <= 0xc2) {
				return { height: d.readUInt16BE(i + 5), width: d.readUInt16BE(i + 7), mime: "image/jpeg" };
			}
			i += 2 + d.readUInt16BE(i + 2);
		}
	}

	return null;
}

const files = readdirSync(from).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();

if (!files.length) {
	console.error(`No photographs in ${from}`);
	process.exit(1);
}

mkdirSync(join(uploads, prefix), { recursive: true });

const insert = db.prepare(
	`INSERT INTO media (id, filename, mime_type, size, width, height, alt, storage_key, status, created_at)
	 VALUES (?,?,?,?,?,?,?,?,'ready',?)`,
);

// A file already loaded keeps the media row it has, so the script can be run
// again with a bigger folder without duplicating what is already there.
const known = new Set(
	db.prepare("SELECT storage_key FROM media WHERE storage_key LIKE ?")
		.all(`${prefix}/%`)
		.map((r) => r.storage_key),
);

const now = new Date().toISOString();
let added = 0;

db.exec("BEGIN");

for (const file of files) {
	const key = `${prefix}/${file}`;

	if (known.has(key)) continue;

	const source = join(from, file);
	const size = readFileSync(source).length;
	const dim = dimensions(source);

	if (!dim) {
		console.warn(`skipped ${file}: not a JPEG or PNG`);
		continue;
	}

	copyFileSync(source, join(uploads, key));

	const alt = basename(file, extname(file)).replace(/[-_]/g, " ")
		.replace(/\d+$/, "").trim();

	insert.run(ulid(), file, dim.mime, size, dim.width, dim.height,
		alt ? `A ${alt} photograph` : "Property photograph", key, now);
	added += 1;
}

db.exec("COMMIT");

// Hand them out by what the property is. The packs name two families in the
// filename - mediterranean for outside, interiors for inside - so an apartment
// gets a room and a villa gets a view, and a building plot gets neither.
const library = db
	.prepare("SELECT id, storage_key FROM media WHERE storage_key LIKE ? ORDER BY storage_key")
	.all(`${prefix}/%`);

const ids = library.map((r) => r.id);
const outside = library.filter((r) => /mediterranean/i.test(r.storage_key)).map((r) => r.id);
const inside = library.filter((r) => /interiors/i.test(r.storage_key)).map((r) => r.id);
const INSIDE_TYPES = ["apartment", "penthouse", "duplex", "townhouse"];
const NO_PHOTOGRAPH = ["plot", "commercial"];

const properties = db
	.prepare(
		"SELECT id, property_type FROM ec_properties WHERE deleted_at IS NULL ORDER BY id",
	)
	.all();

const setImage = db.prepare("UPDATE ec_properties SET featured_image = ? WHERE id = ?");

// Pick by a hash of the property's own id rather than by its position in this
// list. Dealing round robin looks even until the page is sorted by something
// else: a price-ordered search puts neighbouring properties next to each other,
// their positions were consecutive, and the same photograph appears twice in one
// row of cards. A hash has no such correlation with any ordering the site uses.
// FNV-1a, which is short enough to read and good enough for dealing pictures.
const hash = (s) => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i += 1) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
};

db.exec("BEGIN");

let placed = 0;

for (const row of properties) {
	if (NO_PHOTOGRAPH.includes(row.property_type)) {
		setImage.run(null, row.id);
		continue;
	}

	const pool = INSIDE_TYPES.includes(row.property_type)
		? (inside.length ? inside : ids)
		: (outside.length ? outside : ids);

	setImage.run(pool[hash(row.id) % pool.length], row.id);
	placed += 1;
}

db.exec("COMMIT");

console.log(
	`${ids.length} photographs (${outside.length} outside, ${inside.length} inside, `
	+ `${added} new this run), on ${placed} of ${properties.length} properties `
	+ `(${uploads}/${prefix}/)`,
);

// A page of results shows twelve cards, so say plainly whether the library is
// big enough for twelve different ones. Fewer photographs than cards guarantees
// a repeat however they are dealt, and a demo that repeats looks like a bug.
for (const [name, pool] of [["outside", outside], ["inside", inside]]) {
	if (pool.length && pool.length < 12) {
		console.warn(
			`only ${pool.length} ${name} photographs: a full page of results cannot `
			+ `show twelve different ones. Point --from at a bigger folder.`,
		);
	}
}
