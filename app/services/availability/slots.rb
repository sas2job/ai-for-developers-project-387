module Availability
  class Slots
    TIME_ZONE = "Europe/Moscow"
    WINDOW_DAYS = 14
    WORKDAY_START = 9
    WORKDAY_END = 18
    STEP_MINUTES = 30

    Slot = Struct.new(:starts_at, :ends_at, keyword_init: true)

    def self.window_dates(now: Time.current)
      today = now.in_time_zone(TIME_ZONE).to_date
      Array.new(WINDOW_DAYS) { |offset| today + offset }
    end

    def self.date_in_window?(date, now: Time.current)
      window_dates(now: now).include?(date)
    end

    def self.valid_start?(event_type:, starts_at:, now: Time.current)
      local_start = starts_at.in_time_zone(TIME_ZONE)
      date = local_start.to_date
      return false unless date_in_window?(date, now: now)
      return false if date.saturday? || date.sunday?
      return false unless (local_start.min % STEP_MINUTES).zero? && local_start.sec.zero? && local_start.usec.zero?
      return false unless starts_at > now

      start_minutes = local_start.hour * 60 + local_start.min
      end_minutes = start_minutes + event_type.duration_minutes
      start_minutes >= WORKDAY_START * 60 && end_minutes <= WORKDAY_END * 60
    end

    def initialize(event_type:, date:, now: Time.current)
      @event_type = event_type
      @date = date
      @now = now.in_time_zone(TIME_ZONE)
      @time_zone = ActiveSupport::TimeZone[TIME_ZONE]
    end

    def call
      return [] unless self.class.date_in_window?(@date, now: @now)
      return [] if @date.saturday? || @date.sunday?

      slots = []
      starts_at = local_time(WORKDAY_START)
      workday_end = local_time(WORKDAY_END)
      duration = @event_type.duration_minutes.minutes

      while starts_at + duration <= workday_end
        ends_at = starts_at + duration
        slots << Slot.new(starts_at: starts_at, ends_at: ends_at) if available?(starts_at, ends_at)
        starts_at += STEP_MINUTES.minutes
      end

      slots
    end

    private

    def local_time(hour)
      @time_zone.local(@date.year, @date.month, @date.day, hour)
    end

    def available?(starts_at, ends_at)
      starts_at > @now && !Booking.where("starts_at < :slot_end AND ends_at > :slot_start",
        slot_start: starts_at,
        slot_end: ends_at).exists?
    end
  end
end
