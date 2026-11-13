require "test_helper"

class BookingTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  setup do
    Booking.delete_all
    EventType.delete_all
    @event_type = EventType.create!(name: "Consultation", description: "Talk", duration_minutes: 30)
    @other_type = EventType.create!(name: "Planning", description: "Plan", duration_minutes: 45)
  end

  teardown do
    Booking.delete_all
    EventType.delete_all
  end

  test "allows adjacent intervals" do
    starts_at = Time.utc(2030, 1, 7, 9)
    create_booking(@event_type, starts_at)

    adjacent = create_booking(@other_type, starts_at + 30.minutes)

    assert_predicate adjacent, :persisted?
  end

  test "database constraint rejects overlaps across event types" do
    starts_at = Time.utc(2030, 1, 7, 9)
    create_booking(@event_type, starts_at)

    error = assert_raises(ActiveRecord::StatementInvalid) do
      create_booking(@other_type, starts_at + 15.minutes)
    end

    assert_instance_of PG::ExclusionViolation, error.cause
  end

  test "database constraint rejects partial overlaps across different event types" do
    long_event_type = EventType.create!(name: "Long consultation", description: "Long talk", duration_minutes: 60)
    short_event_type = EventType.create!(name: "Short planning", description: "Short plan", duration_minutes: 30)
    starts_at = Time.utc(2030, 1, 7, 10)
    create_booking(long_event_type, starts_at)

    error = assert_raises(ActiveRecord::StatementInvalid) do
      create_booking(short_event_type, starts_at + 30.minutes)
    end

    assert_instance_of PG::ExclusionViolation, error.cause
  end

  test "concurrent overlapping inserts cannot both succeed" do
    starts_at = Time.utc(2030, 1, 7, 9)
    barrier = Queue.new

    results = [ @event_type, @other_type ].map do |event_type|
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          barrier.pop

          begin
            create_booking(event_type, starts_at)
            :created
          rescue ActiveRecord::StatementInvalid => error
            raise unless error.cause.is_a?(PG::ExclusionViolation)

            :conflict
          end
        end
      end
    end

    results.length.times { barrier << true }
    outcomes = results.map(&:value)

    assert_equal 1, outcomes.count(:created)
    assert_equal 1, outcomes.count(:conflict)
    assert_equal 1, Booking.count
  end

  private

  def create_booking(event_type, starts_at)
    event_type.bookings.create!(
      starts_at: starts_at,
      ends_at: starts_at + event_type.duration_minutes.minutes,
      guest_name: "Guest",
      guest_email: "guest@example.com",
    )
  end
end
