require "test_helper"

class EventTypeTest < ActiveSupport::TestCase
  test "requires a name, description, and positive integer duration" do
    event_type = EventType.new(name: "", description: "", duration_minutes: 0)

    assert_not event_type.valid?
    assert_includes event_type.errors.attribute_names, :name
    assert_includes event_type.errors.attribute_names, :description
    assert_includes event_type.errors.attribute_names, :duration_minutes
  end

  test "allows event types with the same name" do
    first = EventType.create!(name: "Consultation", description: "First", duration_minutes: 30)
    second = EventType.create!(name: "Consultation", description: "Second", duration_minutes: 45)

    assert_not_equal first.id, second.id
  end
end
