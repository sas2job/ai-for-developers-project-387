require "test_helper"

class AvailabilitySlotsTest < ActiveSupport::TestCase
  setup do
    @event_type = EventType.create!(name: "Consultation", description: "Talk", duration_minutes: 30)
    @monday = Date.new(2030, 1, 7)
    @now = Time.utc(2030, 1, 7, 5)
  end

  test "generates thirty-minute starts in the Moscow workday" do
    slots = slots_for(@event_type, @monday)

    assert_equal 18, slots.length
    assert_equal "2030-01-07T06:00:00Z", slots.first.starts_at.utc.iso8601
    assert_equal "2030-01-07T15:00:00Z", slots.last.ends_at.utc.iso8601
  end

  test "omits starts whose full duration would extend past 18:00" do
    longer_type = EventType.create!(name: "Long consultation", description: "Talk", duration_minutes: 45)

    slots = slots_for(longer_type, @monday)

    assert_equal "17:00", slots.last.starts_at.strftime("%H:%M")
    assert_equal "17:45", slots.last.ends_at.strftime("%H:%M")
  end

  test "does not offer past starts today" do
    now = Time.utc(2030, 1, 7, 6, 31)

    slots = slots_for(@event_type, @monday, now: now)

    assert_equal "10:00", slots.first.starts_at.strftime("%H:%M")
  end

  test "omits slots overlapping bookings of any event type but allows adjacency" do
    other_type = EventType.create!(name: "Planning", description: "Plan", duration_minutes: 30)
    other_type.bookings.create!(
      starts_at: Time.utc(2030, 1, 7, 6),
      ends_at: Time.utc(2030, 1, 7, 6, 30),
      guest_name: "Guest",
      guest_email: "guest@example.com"
    )

    slots = slots_for(@event_type, @monday)

    assert_equal "09:30", slots.first.starts_at.strftime("%H:%M")
  end

  test "offers no slots on weekends" do
    sunday = Date.new(2030, 1, 6)

    assert_empty slots_for(@event_type, sunday)
  end

  test "window includes today and the next thirteen dates" do
    dates = Availability::Slots.window_dates(now: @now)

    assert_equal @monday, dates.first
    assert_equal @monday + 13, dates.last
    assert_equal 14, dates.length
    assert_not Availability::Slots.date_in_window?(@monday + 14, now: @now)
  end

  private

  def slots_for(event_type, date, now: @now)
    Availability::Slots.new(event_type: event_type, date: date, now: now).call
  end
end
