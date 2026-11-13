class CreateEventTypes < ActiveRecord::Migration[8.1]
  def change
    create_table :event_types do |t|
      t.string :name, null: false
      t.text :description, null: false
      t.integer :duration_minutes, null: false

      t.timestamps
    end

    add_check_constraint :event_types, "duration_minutes > 0", name: "event_types_duration_minutes_positive"
  end
end
