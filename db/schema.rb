# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_10_31_190000) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "btree_gist"
  enable_extension "pg_catalog.plpgsql"

  create_table "bookings", force: :cascade do |t|
    t.bigint "event_type_id", null: false
    t.timestamptz "starts_at", null: false
    t.timestamptz "ends_at", null: false
    t.string "guest_name", null: false
    t.string "guest_email", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["event_type_id"], name: "index_bookings_on_event_type_id"
    t.check_constraint "ends_at > starts_at", name: "bookings_end_after_start"
    t.exclusion_constraint "tstzrange(starts_at, ends_at, '[)'::text) WITH &&", using: :gist, name: "bookings_no_overlapping_intervals"
  end

  create_table "event_types", force: :cascade do |t|
    t.string "name", null: false
    t.text "description", null: false
    t.integer "duration_minutes", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.check_constraint "duration_minutes > 0", name: "event_types_duration_minutes_positive"
  end

  add_foreign_key "bookings", "event_types"
end
