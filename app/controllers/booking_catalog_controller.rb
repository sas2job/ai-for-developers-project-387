class BookingCatalogController < ApplicationController
  def index
    return unless params[:event_type_id].present?

    @selected_event_type = EventType.find_by(id: params[:event_type_id])
    return head :not_found unless @selected_event_type

    @dates = Availability::Slots.window_dates
    @selected_date = @dates.find { |date| date.iso8601 == params[:date] } || @dates.first
    @slots = Availability::Slots.new(event_type: @selected_event_type, date: @selected_date).call
  end
end
