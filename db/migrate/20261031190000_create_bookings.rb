class CreateBookings < ActiveRecord::Migration[8.1]
  def change
    enable_extension "btree_gist"

    create_table :bookings do |t|
      t.references :event_type, null: false, foreign_key: true
      t.timestamptz :starts_at, null: false
      t.timestamptz :ends_at, null: false
      t.string :guest_name, null: false
      t.string :guest_email, null: false

      t.timestamps
      t.check_constraint "ends_at > starts_at", name: "bookings_end_after_start"
    end

    add_exclusion_constraint :bookings,
      "tstzrange(starts_at, ends_at, '[)') WITH &&",
      using: :gist,
      name: "bookings_no_overlapping_intervals"
  end
end
